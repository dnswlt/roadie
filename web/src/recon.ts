// The Jira Recon view (notes/JIRA.md): run a user-supplied JQL query against
// the deployment's tracker connection and list the issues it returns, one
// explicitly fetched page at a time — "Load more" is the only way to another
// page, so a single action can never download a whole Jira deployment.
//
// Tracker results live in view-local module state, deliberately outside
// AppState: they are not roadmap content (not snapshotted, not exported, not
// rendered by any chart view). They survive view switches but not a reload.
// The selected tab is navigation state and lives in AppState.
//
// Rendering follows render.ts/wbs.ts: full rebuild from state on every call.
// The editable fields get the panel's courtesy: their text lives in module
// state (synced on input, never rendering per keystroke) and their caret/focus
// are restored across a rebuild, so a response landing mid-typing cannot eat a
// half-written query or script. See textBoxes.

import { actions } from "./actions";
import { api } from "./api";
import { laneColorValue } from "./colors";
import { confirmDialog, promptDialog } from "./dialogs";
import { icons } from "./icons";
import { appendLinkToDescription } from "./links";
import { openPopover, type PopoverHandle } from "./popover";
import {
  diffTrackerIssues,
  projectRoadieJiraLinks,
  type ReconciledIssue,
  type ScheduleCheckItem,
  type UnreferencedRoadieItem,
} from "./recon-diff";
import { createSearchList } from "./search-list";
import {
  isScheduleCheckMismatch,
  projectScheduleCheck,
  reportScheduleCheck,
  resolveExtractedRange,
  scheduleCheckKeys,
  type ScheduleCheckMismatch,
  type ScheduleCheckProblem,
  type ScheduleCheckProblemKind,
  type ScheduleCheckProjection,
  type ScheduleCheckReport,
  type ScheduleCheckRow,
} from "./schedule-check";
import { periodRangeText } from "./schedule";
import { state, type ItemLocation, type ReconTab } from "./state";
import { dayOf, formatDay } from "./timescale";
import { toast } from "./toast";
import { syncUrl } from "./url";
import type {
  TrackerExtractorTest,
  TrackerIssue,
  TrackerQuery,
  TrackerScheduleStatus,
} from "./types";

let query = "";
// The query the loaded results and cursor belong to — Load more must send
// this, not the editor's current text: editing the box does not invalidate the
// loaded list, only Run does. null = never ran.
let ranQuery: string | null = null;
let issues: TrackerIssue[] = [];
// Opaque continuation cursor for the next page; undefined = no more pages.
let next: string | undefined;
let loading = false;
let error: string | null = null;
// A local projection over the loaded page set. It survives view switches like
// the results themselves, and never causes another tracker request.
let unmatchedOnly = false;
// The Roadie list's one local projection. Children remain independently
// reconciled; this only lets a review temporarily narrow to top-level items.
let topLevelOnly = false;
// A Roadie-row + starts a short cross-tab linking mode. The roadmap id keeps a
// target from ever following an item-id collision into another roadmap.
let linkTarget: { roadmapId: number; itemId: number } | null = null;
let linkingIssueKey: string | null = null;
// Stamps each fetch so a slow response cannot apply over a newer run's
// results: bumped at every start, checked before applying.
let seq = 0;

// Saved queries ("favourites") for the roadmap `favsFor`, fetched from the
// backend when Recon renders for a roadmap it hasn't seen. Unlike the results
// above they ARE roadmap-scoped, so a roadmap switch reloads them.
let favourites: TrackerQuery[] = [];
let favsFor: number | null = null;
let favsLoading = false;
// The favourite the editor's content came from — set by picking one, moved by
// saving under a new name. The save action prefills its name and may only ever
// write THIS favourite: giving it another favourite's name is rejected by the
// store's uniqueness check, so no overwrite confirm exists and taking over a
// name stays the pencil's (rename's) job. Stale ids self-heal: the lookup
// finding nothing simply means no active favourite.
let activeFavId: number | null = null;
// Whether the Saved menu is rendered. The registry decides *when* it closes
// (popover.ts); this only says whether the current render draws it. Its
// anchors are looked up lazily because this view rebuilds wholesale, which
// would otherwise leave the registry holding a detached menu.
let pickerOpen = false;
let favMenu: PopoverHandle | null = null;

// The issue-to-item picker is a transient search-list popup, like the
// dependency picker: a node that lives inside a row and is removed on dismiss.
let issuePicker: PopoverHandle | null = null;

let mount: HTMLElement | null = null;

// rerender repaints after an async step, but only while Recon is on screen: a
// response landing after the user switched back to a chart must not touch its
// DOM (the module state is kept, so returning shows the result). Deliberately
// not state.notify() — tracker results live outside AppState, and a full
// notify fired by a background response could land mid-drag on the chart,
// which is exactly what events.ts gates refreshes to avoid.
function rerender(): void {
  if (mount && state.navigation.view === "recon") renderRecon(mount);
}

// Reset the cross-tab operation. Returning to the Roadie list makes every exit
// land where the operation started.
function resetLinkMode(): boolean {
  if (linkTarget === null) return false;
  linkTarget = null;
  linkingIssueKey = null;
  state.navigation.tabs.recon = "roadie";
  syncUrl(state);
  return true;
}

// Explicit in-view cancellation (button / Escape) needs a repaint.
export function cancelReconLinkMode(): boolean {
  // A mode that is temporarily off-screen is not an Escape target. This lets
  // somebody inspect WBS/timeline and return without losing the operation,
  // while Escape in those views retains its ordinary editing meaning.
  if (state.navigation.view !== "recon") return false;
  if (!resetLinkMode()) return false;
  rerender();
  return true;
}

async function search(q: string, cursor?: string): Promise<void> {
  const mySeq = ++seq;
  loading = true;
  error = null;
  rerender();
  try {
    const page = await api.searchTracker(q, cursor);
    if (seq !== mySeq) return;
    issues = cursor === undefined ? page.issues : issues.concat(page.issues);
    next = page.next;
  } catch (e) {
    if (seq !== mySeq) return;
    error = e instanceof Error ? e.message : String(e);
  }
  loading = false;
  rerender();
}

// run starts over with the editor's query: rerunning clears the loaded
// results, and a changed query invalidates the old cursor (JIRA.md).
function run(): void {
  const q = query.trim();
  if (!q || loading) return;
  ranQuery = q;
  issues = [];
  next = undefined;
  void search(q);
}

function loadMore(): void {
  if (loading || ranQuery === null || next === undefined) return;
  void search(ranQuery, next);
}

// ensureFavourites loads the current roadmap's saved queries once per roadmap.
// The roadmap is re-checked when the response lands: the user may have
// switched roadmaps (or closed the last one) while the request was in flight,
// and a stale list must not be presented as the new roadmap's favourites.
function ensureFavourites(): void {
  const rm = state.current;
  if (!rm) {
    favourites = [];
    favsFor = null;
    activeFavId = null;
    return;
  }
  if (favsFor === rm.id) return;
  // The loaded list belongs to a different roadmap. Drop it before anything
  // can render or act on it: its rows carry that roadmap's ids, so a rename
  // or delete clicked here would be authorized against it and silently edit
  // the roadmap the user just left.
  favourites = [];
  activeFavId = null;
  if (favsLoading) return;
  favsLoading = true;
  void api.listTrackerQueries(rm.id).then(
    (list) => {
      favsLoading = false;
      if (state.current?.id === rm.id) {
        favourites = list;
        favsFor = rm.id;
      }
      // Repaint either way: after a switch mid-flight this re-enters
      // ensureFavourites, which starts the fetch for the roadmap now open.
      rerender();
    },
    (e: unknown) => {
      favsLoading = false;
      if (state.current?.id === rm.id) {
        // Recorded as loaded-empty rather than retried per render: without
        // this, a failing backend would refetch on every repaint.
        favsFor = rm.id;
        toast(e instanceof Error ? e.message : String(e), true);
      }
      rerender();
    },
  );
}

// reloadFavourites refetches after a mutation, which needs no once-per-roadmap
// bookkeeping — it already knows the list changed.
async function reloadFavourites(roadmapId: number): Promise<void> {
  try {
    const list = await api.listTrackerQueries(roadmapId);
    if (state.current?.id !== roadmapId) return;
    favourites = list;
    favsFor = roadmapId;
  } catch {
    // The mutation's own toast already reported anything worth saying; the
    // stale list corrects itself on the next reload.
  }
  rerender();
}

// saveCurrent stores the editor's query, prefilled with the name of the
// favourite being worked on (see activeFavId). Keeping that name updates it —
// the pick, refine, save-back flow; a fresh name saves a new favourite and
// makes it the one being worked on. A name some OTHER favourite holds falls
// into the create branch and is rejected by the store, whose message the toast
// relays — the same answer a colliding rename gets.
async function saveCurrent(): Promise<void> {
  const rm = state.current;
  const q = query.trim();
  if (!rm || !q) return;
  const active = favourites.find((f) => f.id === activeFavId);
  const name = (await promptDialog("Save query as", active?.name ?? "", "Save"))?.trim();
  if (!name) return;
  try {
    if (active && active.name === name) {
      await api.updateTrackerQuery(active.id, { query: q });
      toast(`Updated "${name}"`);
    } else {
      const created = await api.createTrackerQuery(rm.id, name, q);
      activeFavId = created.id;
      toast(`Saved "${name}"`);
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
  await reloadFavourites(rm.id);
}

// pickFavourite is the row click: load the query into the editor and rerun it
// — one action, since a favourite exists to be rerun.
// toggleFavMenu is the Saved button. Opening registers with popover.ts, which
// is what dismisses every other popover in the app — and what dismisses this
// one when anything else opens.
function toggleFavMenu(): void {
  if (favMenu?.isOpen()) {
    favMenu.close();
    return;
  }
  pickerOpen = true;
  favMenu = openPopover({
    // Looked up rather than captured: this view rebuilds wholesale, so the
    // menu that is on screen is rarely the node that was open at click time.
    root: () => mount?.querySelector(".recon-fav-menu") ?? null,
    opener: () => mount?.querySelector(".recon-fav-btn") ?? null,
    // Removes just the menu node — deliberately NOT a rerender. Dismissal runs
    // in the capture phase, before the handler of whatever was clicked, so
    // rebuilding the view here would detach that element first: clicking an
    // issue's + while this menu was open left the link picker appended to a
    // row that was no longer in the document. Equivalent to a rerender anyway,
    // since the Saved button looks the same open or closed.
    onDismiss: () => {
      pickerOpen = false;
      mount?.querySelector(".recon-fav-menu")?.remove();
    },
  });
  rerender();
}

// closePicker shuts the Saved menu through its handle, which also removes it
// from the screen — so the paths that close it without otherwise rendering (a
// cancelled rename or delete) leave nothing behind.
function closePicker(): void {
  favMenu?.close();
}

function pickFavourite(fav: TrackerQuery): void {
  closePicker();
  activeFavId = fav.id;
  query = fav.query;
  run();
  rerender(); // run() no-ops on a query already in flight; repaint regardless
}

async function renameFavourite(fav: TrackerQuery): Promise<void> {
  const rm = state.current;
  const name = (await promptDialog("Rename saved query", fav.name, "Rename"))?.trim();
  if (!rm || !name || name === fav.name) return;
  try {
    await api.updateTrackerQuery(fav.id, { name });
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
  await reloadFavourites(rm.id);
}

async function deleteFavourite(fav: TrackerQuery): Promise<void> {
  const rm = state.current;
  if (!rm || !(await confirmDialog(`Delete saved query "${fav.name}"?`))) return;
  try {
    await api.deleteTrackerQuery(fav.id);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
  await reloadFavourites(rm.id);
}

function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

export function renderRecon(container: HTMLElement): void {
  // The issue picker is a node inside a result row, which this render is about
  // to replace; dismissing it first keeps the registry from holding a detached
  // popover. The Saved menu survives instead — it is rebuilt from pickerOpen
  // and finds itself by lookup.
  issuePicker?.close();
  mount = container;
  const activeTab = state.navigation.tabs.recon;
  if (activeTab === "issues") ensureFavourites();
  if (activeTab === "schedule") ensureScript();
  const scrollTop = container.scrollTop;
  const caret = captureCaret(container);

  const root = div("recon");
  const roadieProjection = projectRoadieJiraLinks(state.current, state.me.trackerUrl);
  const unreferenced = roadieProjection.unreferencedItems;
  const checkItems = roadieProjection.scheduleItems;
  if (
    activeTab === "schedule" &&
    scriptFor === state.current?.id &&
    scriptSaved !== null
  ) {
    ensureScheduleStatus(checkItems);
  }
  const currentStatus = sameScheduleStatusIdentity(
    scheduleStatusFor,
    scheduleStatusIdentity(checkItems),
  )
    ? scheduleStatus
    : null;
  const hasScheduleAnswers = currentStatus?.results.some(
    (result) => result.state !== "unchecked",
  ) === true;
  let scheduleProjection = hasScheduleAnswers
    ? projectScheduleCheck(
      checkItems,
      currentStatus?.results ?? [],
      state.current?.periods ?? [],
    )
    : null;
  const scheduleCount = scheduleProjection?.summary.outsideItems;
  // Resolved once per render: the lookup also drops a target that has since
  // vanished, which every issue row would otherwise repeat.
  const target = currentLinkTarget();
  root.append(buildHeader(unreferenced.length, scheduleCount));
  if (activeTab === "issues") {
    const banner = buildLinkModeBanner(target);
    if (banner) root.append(banner);
    root.append(buildQueryForm(), ...buildResults(target));
  } else if (activeTab === "roadie") {
    root.append(...buildRoadieResults(unreferenced));
  } else {
    scheduleProjection ??= projectScheduleCheck(
      checkItems,
      currentStatus?.results ?? [],
      state.current?.periods ?? [],
    );
    root.append(...buildScheduleCheck(checkItems, scheduleProjection, currentStatus?.pending ?? 0));
  }
  container.replaceChildren(root);

  container.scrollTop = scrollTop;
  restoreCaret(container, caret);
}

// The text boxes this view rebuilds under the user: the JQL query, the
// extractor source, the key to test against. Whichever one holds focus has its
// caret put back after a render, so a response landing mid-typing cannot eat
// half a line. Addressed by selector rather than by node, because the node
// that had focus no longer exists by the time it is restored.
const textBoxes = [".recon-input", ".recon-script", ".recon-test-key"];

type TextBox = HTMLInputElement | HTMLTextAreaElement;
type Caret = { selector: string; start: number; end: number };

function captureCaret(container: HTMLElement): Caret | null {
  for (const selector of textBoxes) {
    const el = container.querySelector<TextBox>(selector);
    if (el && el === document.activeElement) {
      return {
        selector,
        start: el.selectionStart ?? el.value.length,
        end: el.selectionEnd ?? el.value.length,
      };
    }
  }
  return null;
}

function restoreCaret(container: HTMLElement, caret: Caret | null): void {
  if (!caret) return;
  const el = container.querySelector<TextBox>(caret.selector);
  if (!el) return;
  el.focus();
  el.setSelectionRange(caret.start, caret.end);
}

function buildHeader(unreferencedCount: number, scheduleCount?: number): HTMLElement {
  const activeTab = state.navigation.tabs.recon;
  const head = div("recon-head");
  const h = document.createElement("h2");
  h.textContent = "Jira Reconciliation";
  head.append(h);

  const tabs = document.createElement("nav");
  tabs.className = "recon-tabs";
  tabs.setAttribute("aria-label", "Reconciliation lists");
  const choices: { id: ReconTab; label: string; description: string; count?: number }[] = [
    {
      id: "issues",
      label: "Jira issues",
      description: "Search Jira for issues that should appear on this roadmap, then link the missing ones.",
    },
    {
      id: "roadie",
      label: "Roadie items",
      description: "Review Roadie items without a Jira link, and link them to an issue.",
      count: unreferencedCount,
    },
    {
      id: "schedule",
      label: "Schedule check",
      description: "Compare the dates of linked Jira issues with the Roadie items that reference them. Issues are highlighted when their start or end falls outside the associated item's dates.",
      count: scheduleCount,
    },
  ];
  for (const choice of choices) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = choice.id === activeTab ? "recon-tab active" : "recon-tab";
    tab.setAttribute("aria-pressed", String(choice.id === activeTab));
    tab.textContent = choice.label;
    if (choice.count !== undefined) {
      const count = document.createElement("span");
      count.className = "recon-tab-count";
      count.textContent = String(choice.count);
      tab.append(count);
    }
    // Switching tabs leaves a pending link alone, exactly as switching views
    // does: the banner comes back with the Jira list. Only Cancel and Escape
    // end the operation.
    tab.addEventListener("click", () => {
      if (choice.id === activeTab) return;
      closePicker();
      issuePicker?.close();
      state.navigation.tabs.recon = choice.id;
      syncUrl(state);
      rerender();
    });
    tabs.append(tab);
  }
  head.append(tabs);
  const intro = document.createElement("p");
  intro.className = "recon-section-intro";
  intro.textContent = choices.find((choice) => choice.id === activeTab)!.description;
  head.append(intro);
  return head;
}

function buildLinkModeBanner(loc: ItemLocation | null): HTMLElement | null {
  if (!loc) return null;

  const banner = div("recon-link-mode");
  banner.style.setProperty("--c", laneColorValue(loc.lane.color));
  const icon = document.createElement("span");
  icon.className = "recon-link-mode-icon";
  icon.append(icons.link(18));
  const copy = div("recon-link-mode-copy");
  const lead = document.createElement("div");
  lead.className = "recon-link-mode-lead";
  lead.append(document.createTextNode("Choose a Jira issue to link to "));
  const title = document.createElement("strong");
  title.textContent = loc.item.title || "(untitled)";
  lead.append(title);
  const hint = document.createElement("div");
  hint.className = "recon-link-mode-hint";
  hint.textContent = "Run or refine the query if needed, then select Link.";
  copy.append(lead, hint);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => cancelReconLinkMode());
  banner.append(icon, copy, cancel);
  return banner;
}

function currentLinkTarget(): ItemLocation | null {
  if (linkTarget === null) return null;
  if (state.current?.id === linkTarget.roadmapId) {
    const loc = state.findItem(linkTarget.itemId);
    if (loc) return loc;
  }
  linkTarget = null;
  linkingIssueKey = null;
  return null;
}

function buildQueryForm(): HTMLElement {
  const head = div("recon-query-wrap");

  const form = document.createElement("form");
  form.className = "recon-query";
  const input = document.createElement("input");
  input.className = "recon-input";
  input.type = "text";
  input.spellcheck = false;
  input.placeholder = "JQL — e.g. project = ROAD AND issuetype = Epic";
  input.value = query;
  const helpBtn = document.createElement("button");
  helpBtn.type = "button";
  helpBtn.className = "icon-btn recon-query-help";
  helpBtn.title = "About Jira reconciliation";
  helpBtn.setAttribute("aria-label", helpBtn.title);
  helpBtn.append(icons.help(18));
  helpBtn.addEventListener("click", () => openReconHelp());
  const runBtn = document.createElement("button");
  runBtn.type = "submit";
  runBtn.className = "btn btn-primary";
  runBtn.textContent = loading ? "Running…" : "Run";
  runBtn.disabled = loading;
  // The save icon keeps a hard-won query; "Saved queries" brings one back. The
  // lightweight picker JIRA.md asks for: a small menu beside the editor, rows
  // that rerun on click, rename/delete on each row — no management page.
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "icon-btn recon-query-save";
  saveBtn.title = "Save query…";
  saveBtn.setAttribute("aria-label", saveBtn.title);
  saveBtn.append(icons.save(18));
  // Typing changes exactly one thing on screen — whether Save is available —
  // so the input syncs that button itself instead of rendering. A rebuild per
  // keystroke would throw away and recreate the whole result list.
  const syncSave = (): void => {
    saveBtn.disabled = query.trim() === "" || !state.current;
  };
  input.addEventListener("input", () => {
    query = input.value;
    syncSave();
  });
  syncSave();
  saveBtn.addEventListener("click", () => void saveCurrent());
  const actions = div("recon-query-actions");
  actions.append(helpBtn, saveBtn, runBtn);
  form.append(buildFavPicker(), input, actions);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run();
  });
  head.append(form);

  if (error !== null) {
    const err = div("recon-error");
    err.textContent = error;
    head.append(err);
  }
  return head;
}

function buildRoadieResults(items: readonly UnreferencedRoadieItem[]): HTMLElement[] {
  if (items.length === 0) {
    const hint = div("recon-hint");
    // "All referenced" and "nothing to reference" are different answers, and
    // an empty roadmap must not be congratulated on its Jira hygiene.
    const anyItems = state.current?.lanes.some((lane) => lane.items.length > 0) ?? false;
    hint.textContent = anyItems
      ? "Every Roadie item has a Jira reference."
      : "No Roadie items to reconcile.";
    return [hint];
  }

  const topLevel = items.filter((item) => item.parentTitle === null);
  const visible = topLevelOnly ? topLevel : items;
  const out: HTMLElement[] = [roadieFilterChip(topLevel.length, items.length)];
  if (visible.length > 0) {
    const list = div("recon-roadie-list");
    for (const item of visible) list.append(roadieItemRow(item));
    out.push(list);
  } else {
    const hint = div("recon-hint recon-filter-empty");
    hint.textContent = "No top-level Roadie items are missing a Jira reference.";
    out.push(hint);
  }
  // Counted below the list, where the Jira tab states its own scope.
  const foot = div("recon-foot");
  const count = div("recon-count");
  const plural = items.length === 1 ? "" : "s";
  count.textContent = topLevelOnly
    ? `${visible.length} top-level among ${items.length} Roadie item${plural} without a Jira reference`
    : `${items.length} Roadie item${plural} without a Jira reference`;
  foot.append(count);
  out.push(foot);
  return out;
}

function roadieFilterChip(topLevel: number, total: number): HTMLElement {
  const bar = div("recon-filters");
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = topLevelOnly ? "recon-filter-chip active" : "recon-filter-chip";
  chip.setAttribute("aria-pressed", String(topLevelOnly));
  chip.setAttribute("aria-label", `Show top-level Roadie items only (${topLevel} of ${total})`);
  chip.append(document.createTextNode("Top-level only"));
  const count = document.createElement("span");
  count.className = "recon-filter-chip-count";
  count.textContent = String(topLevel);
  chip.append(count);
  chip.addEventListener("click", () => {
    topLevelOnly = !topLevelOnly;
    rerender();
  });
  bar.append(chip);
  return bar;
}

function roadieItemRow(item: UnreferencedRoadieItem): HTMLElement {
  const selected = state.isItemSelected(item.itemId);
  const row = div("recon-roadie-item");
  if (item.parentTitle !== null) row.classList.add("child");
  if (selected) row.classList.add("selected");
  row.style.setProperty("--c", laneColorValue(item.laneColor));

  const open = document.createElement("button");
  open.type = "button";
  open.className = "recon-roadie-open";
  open.title = `Show ${item.title || "(untitled)"}`;
  if (selected) open.setAttribute("aria-current", "true");

  const dot = document.createElement("span");
  dot.className = "color-dot";
  dot.setAttribute("aria-hidden", "true");
  const title = document.createElement("span");
  title.className = "recon-roadie-title";
  title.textContent = item.title || "(untitled)";
  const context = document.createElement("span");
  context.className = "recon-roadie-context";
  const laneName = item.laneName || "(untitled context)";
  context.textContent = item.parentTitle !== null
    ? `${laneName} › ${item.parentTitle || "(untitled)"}`
    : laneName;
  open.append(dot, title, context);
  open.addEventListener("click", () => state.jumpTo("item", item.itemId));
  const link = document.createElement("button");
  link.type = "button";
  link.className = "icon-btn recon-roadie-link";
  link.title = `Link a Jira issue to ${item.title || "(untitled)"}`;
  link.setAttribute("aria-label", link.title);
  link.append(icons.plus(14));
  link.addEventListener("click", () => {
    const roadmap = state.current;
    if (!roadmap) return;
    closePicker();
    issuePicker?.close();
    linkTarget = { roadmapId: roadmap.id, itemId: item.itemId };
    // The target may legitimately share an issue with another Roadie item.
    // A stale "Unmatched" filter would hide exactly those candidates while
    // the user is trying to choose, so linking always starts from all results.
    unmatchedOnly = false;
    state.navigation.tabs.recon = "issues";
    // Besides opening the edit rail, this keeps the target highlighted when
    // the user returns to WBS/timeline after linking.
    state.jumpTo("item", item.itemId);
  });
  row.append(open, link);
  return row;
}

// A task reference for the controls on screen, one section per question a user
// has while using them. What reconciliation is for, and how matching works,
// belong to the linked guide — not to a dialog opened mid-task.
function openReconHelp(): void {
  const dlg = document.getElementById("dialog") as HTMLDialogElement;
  dlg.replaceChildren();

  const h = document.createElement("h3");
  h.textContent = "Jira reconciliation";
  const body = div("recon-help");

  const heading = (text: string): HTMLElement => {
    const el = document.createElement("h4");
    el.textContent = text;
    return el;
  };
  const para = (...parts: (string | Node)[]): HTMLElement => {
    const el = document.createElement("p");
    el.append(...parts);
    return el;
  };
  const code = (text: string): HTMLElement => {
    const el = document.createElement("code");
    el.textContent = text;
    return el;
  };

  body.append(
    heading("Jira issues"),
    para(
      "Enter JQL and select Run; Load more fetches the next page. Build substantial queries in Jira first, then paste them here. Unmatched narrows the list to issues no item in this roadmap links to, among the results loaded so far.",
    ),
    heading("Roadie items"),
    para(
      "Items whose description holds no link to this Jira, parents and children alike, independent of the query. Top-level only hides the children.",
    ),
    heading("Schedule check"),
    para(
      "Shows the cached schedule extracted for linked issues. Fetch issues schedules another Jira fetch; the circular-arrow button reads the available results again.",
    ),
    heading("Linking"),
    para(
      "Select + on either list, then choose the counterpart. Roadie appends the issue URL to the item's description, and never changes anything in Jira.",
    ),
    heading("Ordering"),
    para(
      "Issues appear in the order Jira returns them. Add ORDER BY at the end of the JQL, such as ",
      code("ORDER BY updated DESC"),
      " — ascending by default, DESC to reverse, commas between fields.",
    ),
  );

  const quoted = document.createElement("span");
  quoted.className = "recon-help-error";
  quoted.textContent = "The value 'ABC' does not exist for the field 'project'";
  body.append(
    heading("When a query fails"),
    para(
      "Jira reports a project you lack permission for as if it did not exist: “",
      quoted,
      "”. If the project key is correct, check your Jira permissions.",
    ),
  );

  const docsLink = document.createElement("a");
  docsLink.href = "https://dnswlt.github.io/roadie/jira-reconciliation/";
  docsLink.target = "_blank";
  docsLink.rel = "noreferrer";
  docsLink.textContent = "Read the Jira reconciliation guide";
  body.append(heading("More information"), para(docsLink));

  const actions = div("dialog-actions");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-primary";
  close.textContent = "Close";
  close.addEventListener("click", () => dlg.close());
  actions.append(close);

  dlg.append(h, body, actions);
  dlg.showModal();
  // showModal focuses the first focusable node, which is the guide link: Enter
  // would then leave the app for the docs site instead of closing the dialog.
  close.focus();
}

// buildFavPicker builds the "Saved" dropdown: a .menu-wrap so the shared menu
// styling positions the popover, open state held in pickerOpen so it survives
// the full rebuilds this view renders by.
function buildFavPicker(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "menu-wrap recon-fav-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn recon-fav-btn";
  btn.append(document.createTextNode("Saved"), icons.chevronDown(14));
  if (favourites.length === 0) {
    btn.disabled = true;
    btn.title = "No saved queries for this roadmap";
  } else {
    btn.title = "Saved queries";
    btn.addEventListener("click", () => toggleFavMenu());
  }
  wrap.append(btn);
  // No favourites means no menu, whatever pickerOpen says: deleting the last
  // one closes it (deleteFavourite), so this only guards the render.
  if (!pickerOpen || favourites.length === 0) return wrap;

  const menu = document.createElement("div");
  menu.className = "menu recon-fav-menu";
  for (const fav of favourites) {
    const row = document.createElement("div");
    row.className = "recon-fav-row";
    const name = document.createElement("button");
    name.type = "button";
    name.className = "recon-fav-name";
    name.textContent = fav.name;
    name.title = fav.query; // hover answers "which query was that again?"
    name.addEventListener("click", () => pickFavourite(fav));
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "icon-btn";
    rename.title = "Rename";
    rename.append(icons.pencil(14));
    rename.addEventListener("click", () => {
      closePicker();
      void renameFavourite(fav);
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn";
    del.title = "Delete";
    del.append(icons.trash(14));
    del.addEventListener("click", () => {
      closePicker();
      void deleteFavourite(fav);
    });
    row.append(name, rename, del);
    menu.append(row);
  }
  wrap.append(menu);
  return wrap;
}

function buildResults(target: ItemLocation | null): HTMLElement[] {
  if (ranQuery === null) {
    const hint = div("recon-hint");
    hint.textContent = "Run a JQL query to list issues from the connected Jira.";
    return [hint];
  }

  const out: HTMLElement[] = [];
  const reconciled = diffTrackerIssues(issues, state.current);
  const unmatched = reconciled.filter((row) => row.matches.length === 0);
  const visible = unmatchedOnly ? unmatched : reconciled;
  if (issues.length > 0) {
    out.push(filterChip(unmatched.length, issues.length));
    if (visible.length > 0) {
      const list = div("recon-list");
      for (const row of visible) list.append(issueRow(row, target));
      out.push(list);
    } else {
      const hint = div("recon-hint recon-filter-empty");
      hint.textContent = "Every loaded issue is linked to a Roadie item.";
      out.push(hint);
    }
  } else if (loading) {
    const hint = div("recon-hint");
    hint.textContent = "Searching…";
    out.push(hint);
  } else if (error === null) {
    const hint = div("recon-hint");
    hint.textContent = "No issues match this query.";
    out.push(hint);
  }

  // The count states its scope ("loaded", not "found"): the tracker reports no
  // total, and the filter chip counts against loaded issues only — that scope
  // has to stay legible (JIRA.md).
  if (issues.length > 0 || next !== undefined) {
    const foot = div("recon-foot");
    if (next !== undefined) {
      const more = document.createElement("button");
      more.className = "btn";
      more.textContent = loading ? "Loading…" : "Load more";
      more.disabled = loading;
      more.addEventListener("click", () => loadMore());
      foot.append(more);
    }
    const count = div("recon-count");
    const n = issues.length;
    count.textContent = `${unmatched.length} unmatched among ${n} loaded issue${n === 1 ? "" : "s"}${
      next !== undefined ? " · more available" : " · all results loaded"
    }`;
    foot.append(count);
    out.push(foot);
  }
  return out;
}

function filterChip(unmatched: number, loaded: number): HTMLElement {
  const bar = div("recon-filters");
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = unmatchedOnly ? "recon-filter-chip active" : "recon-filter-chip";
  chip.setAttribute("aria-pressed", String(unmatchedOnly));
  chip.setAttribute("aria-label", `Show unmatched issues only (${unmatched} of ${loaded} loaded)`);
  chip.append(document.createTextNode("Unmatched"));
  const count = document.createElement("span");
  count.className = "recon-filter-chip-count";
  count.textContent = String(unmatched);
  chip.append(count);
  chip.addEventListener("click", () => {
    unmatchedOnly = !unmatchedOnly;
    rerender();
  });
  bar.append(chip);
  return bar;
}

function openIssuePicker(row: HTMLElement, issue: TrackerIssue, linkedItemIds: Set<number>): void {
  const pop = div("menu recon-link-pop");
  // Registering is the whole of exclusivity: the Saved menu (and every other
  // popover in the app) is dismissed by this, so nothing here has to know it
  // exists.
  issuePicker = openPopover({ root: pop, onDismiss: () => pop.remove() });
  const close = (): void => issuePicker?.close();

  const picker = createSearchList({
    placeholder: "Link to a Roadie item…",
    maxRows: 8,
    emptyHint: "Type to search Roadie items.",
    filter: (match) => match.kind === "item" && !linkedItemIds.has(match.id),
    onCommit: (match) => {
      close();
      const loc = state.findItem(match.id);
      if (!loc) return;
      const description = appendLinkToDescription(loc.item.description, issue.url);
      void actions.updateItem(match.id, { description });
    },
    onDismiss: close,
  });

  pop.append(picker.el);
  row.append(pop);
  picker.refresh();
  picker.focus();
}

async function linkIssueToTarget(issue: TrackerIssue): Promise<void> {
  const loc = currentLinkTarget();
  if (!loc || linkingIssueKey !== null) return;
  const itemId = loc.item.id;
  const description = appendLinkToDescription(loc.item.description, issue.url);
  linkingIssueKey = issue.key;
  await actions.updateItem(itemId, { description });
  linkingIssueKey = null;

  // updateItem rolls back on failure. Stay in linking mode in that case so the
  // error toast and unchanged Link buttons leave a clear retry path.
  if (state.findItem(itemId)?.item.description !== description) {
    rerender();
    return;
  }
  resetLinkMode();
  rerender();
}

// One result row: enough to identify the issue (key, summary, type, status),
// with the key linking out — opening an issue goes to Jira, never to a Roadie
// rendering of it.
function issueRow({ issue, matches }: ReconciledIssue, target: ItemLocation | null): HTMLElement {
  const row = div("recon-issue");
  const key = document.createElement("a");
  key.className = "recon-issue-key";
  key.href = issue.url;
  key.target = "_blank";
  key.rel = "noreferrer";
  key.title = "Open in Jira";
  key.textContent = issue.key;
  const title = div("recon-issue-title");
  title.textContent = issue.title;
  title.title = issue.title;
  const type = div("recon-issue-type");
  type.textContent = issue.type;
  const status = div("recon-issue-status");
  status.textContent = issue.status;
  row.append(key, title, type, status);
  const add = document.createElement("button");
  add.type = "button";
  if (target) {
    const alreadyLinked = matches.some((match) => match.itemId === target.item.id);
    add.className = "btn btn-primary recon-issue-link-target";
    add.disabled = linkingIssueKey !== null || alreadyLinked;
    add.textContent =
      linkingIssueKey === issue.key ? "Linking…" : alreadyLinked ? "Linked" : "Link";
    add.title = alreadyLinked
      ? `${issue.key} is already linked to ${target.item.title || "(untitled)"}`
      : `Link ${issue.key} to ${target.item.title || "(untitled)"}`;
    if (!alreadyLinked) add.addEventListener("click", () => void linkIssueToTarget(issue));
  } else {
    add.className = "icon-btn recon-issue-add";
    add.title = `Link ${issue.key} to a Roadie item`;
    add.setAttribute("aria-label", add.title);
    add.append(icons.plus(14));
    add.addEventListener("click", () => {
      // No stopPropagation: popover.ts dismisses from the capture phase, so this
      // picker never sees the click that opened it.
      openIssuePicker(row, issue, new Set(matches.map((match) => match.itemId)));
    });
  }
  row.append(add);
  if (matches.length > 0) {
    const linked = div("recon-issue-links");
    for (const match of matches) {
      const displayTitle = match.title || "(untitled)";
      const selected = state.isItemSelected(match.itemId);
      const item = document.createElement("button");
      item.type = "button";
      item.className = selected ? "recon-linked-item selected" : "recon-linked-item";
      item.title = `Show ${displayTitle}`;
      item.style.setProperty("--c", laneColorValue(match.laneColor));
      if (selected) item.setAttribute("aria-current", "true");
      const dot = document.createElement("span");
      dot.className = "color-dot";
      dot.setAttribute("aria-hidden", "true");
      const itemTitle = document.createElement("span");
      itemTitle.className = "recon-linked-item-title";
      itemTitle.textContent = displayTitle;
      item.append(dot, itemTitle);
      // Use the same cross-view jump as Find and dependency links. Besides
      // feeding the edit panel, this makes a hidden/folded item renderable and
      // leaves scrollToSelection set for the next WBS/timeline render.
      item.addEventListener("click", () => state.jumpTo("item", match.itemId));
      linked.append(item);
    }
    row.append(linked);
  }
  return row;
}

// ---------- Schedule check: the extractor script (notes/schedule_check.md) ----------
//
// Jira has no one place where an issue's schedule lives, so a roadmap carries a
// small Starlark script saying which fields to read and how to turn them into a
// date range. This is the editor half of the tab: write it, save it (the server
// refuses one that will not run), and Test it against a single issue.
//
// Test is what makes the script writable at all. A custom field is
// `customfield_10430` and never "Begin Date", and no API here maps one to the
// other — the raw JSON of a real issue is where that id is found.

// The editor's text and the roadmap it belongs to. `scriptSaved` is what the
// server holds, null when the roadmap has no script, which is what separates
// "nothing here yet" from "edited but not saved".
let script = "";
let scriptSaved: string | null = null;
let scriptFor: number | null = null;
let scriptLoading = false;
let saving = false;
let extractorDetailsOpen = false;
// A save error renders inline under the source rather than as a toast: it
// names a line in the text directly above it.
let scriptError: string | null = null;
// The load failed. Kept apart from "no script saved" because the two look
// identical and act very differently: offering a blank editor after a failed
// GET invites saving over a script that is still there.
let scriptLoadError: string | null = null;

let testKey = "";
let testing = false;
let testResult: TrackerExtractorTest | null = null;
let testError: string | null = null;
// Stamps each test like `seq` does a search: a slow answer must not land over
// a newer one's.
let testSeq = 0;

// Results are cached by the backend, but held here only for the current
// roadmap/script/key set. Loading them and scheduling their refresh are
// deliberately separate operations.
let scheduleStatus: TrackerScheduleStatus | null = null;
interface ScheduleStatusIdentity {
  roadmapId: number;
  script: string;
  keys: string[];
}

let scheduleStatusFor: ScheduleStatusIdentity | null = null;
let scheduleStatusLoading = false;
let schedulingJiraReload = false;
let scheduleCheckError: string | null = null;
let scheduleStatusSeq = 0;

// The skeleton "Create a script" starts from. It compiles, returns None for
// everything, and maps no field — deliberately: a guessed field mapping is
// silently wrong for every deployment it does not fit, which is why there is
// no default extractor.
const scriptSkeleton = `# Which Jira fields carry an issue's schedule, and how to read a date range
# out of them. Roadie compares that range against the dates of the roadmap
# item whose description links to the issue.
#
# JIRA_FIELDS holds Jira field *ids*, passed to Jira untouched. System fields
# read well ("fixVersions", "duedate"); a custom field is "customfield_10430",
# never its display name. Test an issue below and read its raw JSON to find
# the id you need.
JIRA_FIELDS = []


def get_issue_time_range(issue):
    # issue is Jira's own JSON: issue["key"], issue["fields"][...], nested as
    # Jira returns it. summary, issuetype and status are always fetched.
    #
    # Return optional start/end dates (YYYY-MM-DD), startPeriod/endPeriod
    # schedule labels, and a label saying where the range came from.
    # Return None to skip the issue: it is then never compared.
    return None
`;

// ensureScript loads the roadmap's script once per roadmap, like
// ensureFavourites: the roadmap is re-checked when the response lands, since
// the user may have switched away while it was in flight.
function ensureScript(): void {
  const rm = state.current;
  if (!rm) {
    resetScript();
    return;
  }
  if (scriptFor === rm.id) return;
  // The loaded text belongs to a different roadmap. Drop it before anything
  // can render or save it, which would write one roadmap's script onto
  // another's.
  resetScript();
  if (scriptLoading) return;
  scriptLoading = true;
  void api.getTrackerExtractor(rm.id).then(
    (ext) => {
      scriptLoading = false;
      if (state.current?.id === rm.id) {
        scriptSaved = ext?.source ?? null;
        script = scriptSaved ?? "";
        scriptFor = rm.id;
      }
      // Repaint either way: after a switch mid-flight this re-enters
      // ensureScript, which starts the fetch for the roadmap now open.
      rerender();
    },
    (e: unknown) => {
      scriptLoading = false;
      if (state.current?.id === rm.id) {
        // Recorded as loaded-with-an-error rather than retried per render:
        // without this a failing backend would refetch on every repaint.
        scriptFor = rm.id;
        scriptLoadError = e instanceof Error ? e.message : String(e);
      }
      rerender();
    },
  );
}

function resetScript(): void {
  script = "";
  scriptSaved = null;
  scriptFor = null;
  scriptError = null;
  scriptLoadError = null;
  extractorDetailsOpen = false;
  testResult = null;
  testError = null;
  resetScheduleStatus();
}

function resetScheduleStatus(): void {
  scheduleStatus = null;
  scheduleStatusFor = null;
  scheduleStatusLoading = false;
  schedulingJiraReload = false;
  scheduleCheckError = null;
  scheduleStatusSeq++;
}

function scheduleStatusIdentity(items: readonly ScheduleCheckItem[]): ScheduleStatusIdentity | null {
  const rm = state.current;
  if (!rm || scriptSaved === null) return null;
  return { roadmapId: rm.id, script: scriptSaved, keys: scheduleCheckKeys(items) };
}

function sameScheduleStatusIdentity(
  a: ScheduleStatusIdentity | null,
  b: ScheduleStatusIdentity | null,
): boolean {
  return a === b || (
    a !== null && b !== null &&
    a.roadmapId === b.roadmapId &&
    a.script === b.script &&
    a.keys.length === b.keys.length &&
    a.keys.every((key, i) => key === b.keys[i])
  );
}

// Opening the tab reads the current cache once. Fetching issues and rereading the
// result list are separate explicit actions; neither starts polling.
function ensureScheduleStatus(items: readonly ScheduleCheckItem[]): void {
  const identity = scheduleStatusIdentity(items);
  if (
    identity === null ||
    sameScheduleStatusIdentity(scheduleStatusFor, identity) ||
    scheduleStatusLoading
  ) return;

  readScheduleStatus(identity, false);
}

function readScheduleStatus(identity: ScheduleStatusIdentity, retainResults: boolean): void {
  const { keys } = identity;
  if (keys.length === 0) {
    scheduleStatus = { results: [], pending: 0 };
    scheduleStatusFor = identity;
    scheduleCheckError = null;
    return;
  }
  const mySeq = ++scheduleStatusSeq;
  if (!retainResults) scheduleStatus = null;
  scheduleStatusFor = identity;
  scheduleStatusLoading = true;
  scheduleCheckError = null;
  void api.getScheduleCheckStatus(identity.roadmapId, keys).then(
    (status) => {
      if (mySeq !== scheduleStatusSeq) return;
      scheduleStatus = status;
      scheduleStatusLoading = false;
      rerender();
    },
    (e: unknown) => {
      if (mySeq !== scheduleStatusSeq) return;
      scheduleStatusLoading = false;
      scheduleCheckError = e instanceof Error ? e.message : String(e);
      rerender();
    },
  );
}

async function enqueueJiraReload(items: readonly ScheduleCheckItem[]): Promise<void> {
  const rm = state.current;
  const identity = scheduleStatusIdentity(items);
  const keys = identity?.keys ?? [];
  if (!rm || identity === null || keys.length === 0 || schedulingJiraReload || scriptDirty()) return;

  schedulingJiraReload = true;
  scheduleCheckError = null;
  rerender();
  try {
    const { queued, pending } = await api.enqueueScheduleCheck(rm.id, keys);
    if (
      state.current?.id !== rm.id ||
      !sameScheduleStatusIdentity(scheduleStatusIdentity(items), identity)
    ) return;
    const results = sameScheduleStatusIdentity(scheduleStatusFor, identity)
      ? scheduleStatus?.results ?? []
      : [];
    scheduleStatus = { results, pending };
    scheduleStatusFor = identity;
    toast(queued === keys.length
      ? "Jira fetch scheduled. Refresh the result list in a moment."
      : `Jira fetch scheduled for ${queued} of ${keys.length} issues; the queue is full.`);
  } catch (e) {
    if (state.current?.id !== rm.id) return;
    scheduleCheckError = e instanceof Error ? e.message : String(e);
  } finally {
    if (state.current?.id === rm.id) {
      schedulingJiraReload = false;
      rerender();
    }
  }
}

function reloadScheduleResults(items: readonly ScheduleCheckItem[]): void {
  const identity = scheduleStatusIdentity(items);
  if (identity === null || scheduleStatusLoading) return;
  readScheduleStatus(identity, sameScheduleStatusIdentity(scheduleStatusFor, identity));
  rerender();
}

function scriptDirty(): boolean {
  return script !== (scriptSaved ?? "");
}

async function saveScript(): Promise<void> {
  const rm = state.current;
  if (!rm || saving || script.trim() === "") return;
  saving = true;
  scriptError = null;
  rerender();
  try {
    const ext = await api.putTrackerExtractor(rm.id, script);
    if (state.current?.id !== rm.id) return;
    scriptSaved = ext.source;
    resetScheduleStatus();
    toast("Extractor script saved");
  } catch (e) {
    if (state.current?.id !== rm.id) return;
    // The server compiles before storing, so this is usually the script's own
    // error with the line it happened on — inline, under the source.
    scriptError = e instanceof Error ? e.message : String(e);
  } finally {
    saving = false;
    rerender();
  }
}

async function deleteScript(): Promise<void> {
  const rm = state.current;
  if (!rm || scriptSaved === null) return;
  if (!(await confirmDialog("Delete this roadmap's extractor script?"))) return;
  try {
    await api.deleteTrackerExtractor(rm.id);
    if (state.current?.id !== rm.id) return;
    scriptSaved = null;
    script = "";
    scriptError = null;
    resetScheduleStatus();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
  rerender();
}

// runTest sends the editor's text, not the saved script: Test is how a script
// is arrived at, so it has to run before Save would accept it.
async function runTest(): Promise<void> {
  const rm = state.current;
  const key = testKey.trim();
  if (!rm || testing || key === "") return;
  const mySeq = ++testSeq;
  testing = true;
  testError = null;
  testResult = null;
  rerender();
  try {
    const res = await api.testTrackerExtractor(rm.id, script, key);
    if (testSeq !== mySeq) return;
    testResult = res;
  } catch (e) {
    if (testSeq !== mySeq) return;
    // Reported under the Test box and not under the source, even for a script
    // that does not compile — which this refuses exactly as Save does. Two
    // copies of one message read as two problems.
    testError = e instanceof Error ? e.message : String(e);
  }
  testing = false;
  rerender();
}

function buildScheduleCheck(
  items: readonly ScheduleCheckItem[],
  projection: ScheduleCheckProjection,
  pending: number,
): HTMLElement[] {
  const rm = state.current;
  if (!rm) return [];
  if (scriptLoadError !== null) return [buildScriptLoadError()];
  if (scriptFor !== rm.id) {
    const hint = div("recon-hint");
    hint.textContent = "Loading the extractor script…";
    return [hint];
  }
  // Nothing saved and nothing typed: explain the tab and offer a starting
  // point, rather than presenting an empty box that means nothing.
  if (scriptSaved === null && script === "") return [buildScriptIntro()];
  const editor = buildExtractorDetails();
  if (scriptSaved === null) return [editor];
  return [buildScheduleResults(items, projection, pending), editor];
}

function buildScheduleResults(
  items: readonly ScheduleCheckItem[],
  projection: ScheduleCheckProjection,
  pending: number,
): HTMLElement {
  const wrap = div("recon-schedule");
  const head = div("recon-schedule-head");
  const h = document.createElement("h3");
  h.textContent = "Results";
  const hasAnswers = projection.summary.checked + projection.summary.skipped +
    projection.summary.errors + projection.summary.notFound > 0;
  const actions = div("recon-schedule-actions");
  const check = document.createElement("button");
  check.type = "button";
  check.className = "btn btn-primary";
  check.textContent = schedulingJiraReload ? "Scheduling…" : "Fetch issues";
  check.disabled =
    schedulingJiraReload || scheduleStatusLoading || items.length === 0 || scriptDirty();
  check.title = scriptDirty()
    ? "Save the extractor before fetching issues"
    : "Schedules a reload of linked Jira issues";
  check.addEventListener("click", () => void enqueueJiraReload(items));

  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "icon-btn";
  reload.title = "Refreshes the result list";
  reload.setAttribute("aria-label", "Refresh result list");
  reload.disabled = scheduleStatusLoading || schedulingJiraReload;
  reload.append(icons.rotateCcw(16));
  reload.addEventListener("click", () => reloadScheduleResults(items));

  if (pending > 0) {
    const progress = div("recon-count");
    progress.textContent = `${pending} issue${pending === 1 ? "" : "s"} refreshing`;
    actions.append(progress);
  }
  actions.append(check, reload);
  head.append(h, actions);
  wrap.append(head);

  if (scheduleCheckError !== null) {
    const error = div("recon-error");
    error.textContent = scheduleCheckError;
    wrap.append(error);
  }
  if (items.length === 0) {
    const hint = div("recon-hint recon-schedule-hint");
    hint.textContent = "No Roadie items link to Jira issues.";
    wrap.append(hint);
    return wrap;
  }
  if (!hasAnswers) {
    const hint = div("recon-hint recon-schedule-hint");
    const keys = scheduleCheckKeys(items).length;
    hint.textContent = `${keys} linked Jira issue${keys === 1 ? "" : "s"} across ${items.length} Roadie item${items.length === 1 ? "" : "s"}.`;
    wrap.append(hint);
    return wrap;
  }

  const discrepancies = projection.rows.filter(isScheduleMismatchRow);
  if (projection.summary.checked > 0 && discrepancies.length === 0) {
    const hint = div("recon-hint recon-filter-empty");
    hint.textContent = "No schedule discrepancies.";
    wrap.append(hint);
  } else {
    const list = div("recon-schedule-list");
    for (const row of discrepancies) list.append(scheduleItemRow(row));
    wrap.append(list);
  }
  const report = reportScheduleCheck(projection);
  const foot = div("recon-foot");
  if (projection.summary.checked > 0) {
    const count = div("recon-count");
    count.textContent = scheduleMatchSummary(report);
    foot.append(count);
  }
  const remainder = scheduleRemainderSummary(report);
  if (remainder) {
    const secondary = div("recon-count");
    secondary.textContent = remainder;
    foot.append(secondary);
  }
  if (foot.childElementCount > 0) wrap.append(foot);
  wrap.append(...buildScheduleProblems(report));
  return wrap;
}

function scheduleMatchSummary(report: ScheduleCheckReport): string {
  const issues = report.matchingIssues === 1 ? "issue" : "issues";
  const items = report.matchingItems === 1 ? "item" : "items";
  return `${report.matchingIssues} ${issues} in ${report.matchingItems} ${items} match the schedule.`;
}

function scheduleRemainderSummary(report: ScheduleCheckReport): string {
  const parts: string[] = [];
  if (report.skippedIssues > 0) {
    const issues = report.skippedIssues === 1 ? "issue" : "issues";
    parts.push(`${report.skippedIssues} ${issues} skipped`);
  }
  if (report.uncheckedIssues > 0) parts.push(`${report.uncheckedIssues} not checked`);
  return parts.join(" · ");
}

const maxScheduleProblems = 10;

function buildScheduleProblems(report: ScheduleCheckReport): HTMLElement[] {
  const groups: { kind: ScheduleCheckProblemKind; heading: string }[] = [
    { kind: "script", heading: "Script execution errors" },
    { kind: "schedule", heading: "Schedule errors" },
    { kind: "tracker", heading: "Tracker errors" },
    { kind: "notFound", heading: "Issues not found" },
  ];
  const sections: HTMLElement[] = [];
  for (const group of groups) {
    const problems = report.problems[group.kind];
    if (problems.length === 0) continue;
    const section = div("recon-schedule-problems");
    const heading = document.createElement("h4");
    heading.textContent = `${group.heading} (${problems.length})`;
    const list = div("recon-schedule-problem-list");
    for (const problem of problems.slice(0, maxScheduleProblems)) {
      list.append(scheduleProblemRow(problem));
    }
    section.append(heading, list);
    const omitted = problems.length - maxScheduleProblems;
    if (omitted > 0) {
      const more = div("recon-count recon-schedule-problem-more");
      more.textContent = `${omitted} more not shown`;
      section.append(more);
    }
    sections.push(section);
  }
  return sections;
}

function scheduleProblemRow(problem: ScheduleCheckProblem): HTMLElement {
  const row = div("recon-schedule-problem");
  const key = problem.issue ? document.createElement("a") : document.createElement("span");
  key.className = "recon-issue-key";
  key.textContent = problem.key;
  if (key instanceof HTMLAnchorElement && problem.issue) {
    key.href = problem.issue.url;
    key.target = "_blank";
    key.rel = "noreferrer";
  }
  const title = document.createElement("span");
  title.className = "recon-schedule-problem-title";
  title.textContent = problem.issue?.title ?? "";
  row.append(key, title);
  if (problem.message) {
    const message = div("recon-schedule-problem-message");
    message.textContent = problem.message;
    row.append(message);
  }
  return row;
}

type ScheduleMismatchRow = ScheduleCheckRow & { outside: true };

function isScheduleMismatchRow(row: ScheduleCheckRow): row is ScheduleMismatchRow {
  return row.outside;
}

function scheduleItemRow(row: ScheduleMismatchRow): HTMLElement {
  const wrap = div("recon-schedule-item");
  if (row.parentTitle !== null) wrap.classList.add("child");
  wrap.classList.add("outside");
  wrap.style.setProperty("--c", laneColorValue(row.laneColor));

  const head = div("recon-schedule-item-head");
  const open = document.createElement("button");
  open.type = "button";
  open.className = "recon-schedule-item-open";
  open.title = `Show ${row.title || "(untitled)"}`;
  const dot = document.createElement("span");
  dot.className = "color-dot";
  dot.setAttribute("aria-hidden", "true");
  const name = div("recon-schedule-item-name");
  const title = document.createElement("span");
  title.textContent = row.title || "(untitled)";
  const context = document.createElement("span");
  context.textContent = row.parentTitle === null
    ? row.laneName
    : `${row.laneName} › ${row.parentTitle || "(untitled)"}`;
  name.append(title, context);
  const range = div("recon-schedule-item-range");
  range.textContent = periodRangeText(
    state.current?.periods ?? [],
    row.startDate,
    row.endDate,
    formatIsoDate,
  );
  open.append(dot, name, range);
  open.addEventListener("click", () => state.jumpTo("item", row.itemId));
  head.append(open);
  wrap.append(head);
  for (const issue of row.issues) {
    if (isScheduleCheckMismatch(issue)) wrap.append(scheduleIssueRow(issue));
  }
  return wrap;
}

function scheduleIssueRow(issue: ScheduleCheckMismatch): HTMLElement {
  const row = div("recon-schedule-issue");
  const key = issue.issue ? document.createElement("a") : document.createElement("span");
  key.className = "recon-issue-key";
  key.textContent = issue.key;
  if (key instanceof HTMLAnchorElement && issue.issue) {
    key.href = issue.issue.url;
    key.target = "_blank";
    key.rel = "noreferrer";
    key.title = "Open in Jira";
  }
  const title = document.createElement("span");
  title.className = "recon-schedule-issue-title";
  title.textContent = issue.issue?.title ?? "";
  const value = scheduleIssueRange(issue);
  const source = document.createElement("span");
  source.className = "recon-schedule-issue-source";
  const sourceText = issue.label ?? "";
  // Avoid repeating identical adjacent label and status text.
  source.textContent = sourceText === issue.issue?.status ? "" : sourceText;
  const jiraStatus = document.createElement("span");
  jiraStatus.className = "recon-issue-status recon-schedule-jira-status";
  jiraStatus.textContent = issue.issue?.status ?? "";
  row.append(key);
  for (const part of [title, jiraStatus, source, value]) {
    if (part.textContent !== "") row.append(part);
  }
  const warning = document.createElement("span");
  warning.className = "recon-schedule-warning";
  warning.title = "Outside Roadie item range";
  warning.setAttribute("aria-label", warning.title);
  warning.append(icons.clock(15));
  row.append(warning);
  return row;
}

function scheduleIssueRange(issue: ScheduleCheckMismatch): HTMLElement {
  const range = document.createElement("span");
  range.className = "recon-schedule-issue-range";
  // Each edge keeps the explicit date or period vocabulary chosen by the extractor.
  const boundary = (date: string, period: string | undefined, outside: boolean): HTMLElement => {
    const value = document.createElement("span");
    if (outside) value.className = "outside";
    value.textContent = period ?? formatIsoDate(date);
    return value;
  };
  if (issue.start && issue.end) {
    if (issue.startPeriod && issue.startPeriod === issue.endPeriod) {
      range.append(boundary(
        issue.start,
        issue.startPeriod,
        issue.startOutside === true || issue.endOutside === true,
      ));
    } else {
      range.append(
        boundary(issue.start, issue.startPeriod, issue.startOutside === true),
        document.createTextNode(" – "),
        boundary(issue.end, issue.endPeriod, issue.endOutside === true),
      );
    }
  } else if (issue.start) {
    range.append("Starts ", boundary(issue.start, issue.startPeriod, issue.startOutside === true));
  } else if (issue.end) {
    range.append("Ends ", boundary(issue.end, issue.endPeriod, issue.endOutside === true));
  } else {
    range.textContent = "—";
  }
  return range;
}

function buildScriptLoadError(): HTMLElement {
  const wrap = div("recon-hint");
  const msg = div("recon-error");
  msg.textContent = `Could not load this roadmap's extractor script: ${scriptLoadError}`;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => {
    resetScript();
    rerender();
  });
  wrap.append(msg, retry);
  return wrap;
}

function buildScriptIntro(): HTMLElement {
  const wrap = div("recon-script-intro");
  const lead = document.createElement("p");
  lead.textContent =
    "Jira keeps an issue's schedule wherever a deployment decided to: a fix version, a sprint, a due date, a custom field. A short script for this roadmap says which fields to read and how to turn them into a date range; Roadie then checks every linked issue against the dates of the item that links to it.";
  const why = document.createElement("p");
  why.textContent =
    "There is no default script, because a guessed field mapping is silently wrong for every deployment it does not fit. Start from the skeleton and use Test to find out what this Jira calls its fields.";
  const create = document.createElement("button");
  create.type = "button";
  create.className = "btn btn-primary";
  create.textContent = "Create a script";
  create.addEventListener("click", () => {
    script = scriptSkeleton;
    extractorDetailsOpen = true;
    rerender();
  });
  wrap.append(lead, why, create);
  return wrap;
}

function buildExtractorDetails(): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "recon-extractor-details";
  details.open = extractorDetailsOpen;
  const summary = document.createElement("summary");
  summary.textContent = "Extractor script and test";
  const body = div("recon-extractor-details-body");
  body.append(buildScriptEditor(), buildTestPanel());
  details.append(summary, body);
  details.addEventListener("toggle", () => {
    extractorDetailsOpen = details.open;
  });
  return details;
}

function buildScriptEditor(): HTMLElement {
  const wrap = div("recon-script-wrap");
  const area = document.createElement("textarea");
  area.className = "recon-script";
  area.spellcheck = false;
  area.rows = 12;
  area.value = script;
  area.setAttribute("aria-label", "Extractor script");

  const bar = div("recon-script-actions");
  const status = div("recon-script-status");
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn-primary";
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn recon-script-delete";
  delBtn.textContent = "Delete";
  delBtn.disabled = scriptSaved === null;
  delBtn.title = scriptSaved === null ? "Nothing is saved yet" : "Delete the saved script";
  delBtn.addEventListener("click", () => void deleteScript());

  // Typing changes exactly two things on screen — the Save button and the
  // status line — so the textarea syncs those itself. Rendering per keystroke
  // would rebuild the box being typed into.
  //
  // Save stays available on text that is already saved. Greying it out there
  // reads as "you may not save this" and offers nothing that says why, where
  // the status line beside it already says whether anything changed — and a
  // re-save is a re-validation, which is a reasonable thing to want.
  const sync = (): void => {
    saveBtn.textContent = saving ? "Saving…" : "Save";
    saveBtn.disabled = saving || script.trim() === "";
    status.textContent = scriptDirty()
      ? "Unsaved changes"
      : scriptSaved === null
        ? "Not saved yet"
        : "Saved";
  };
  area.addEventListener("input", () => {
    script = area.value;
    sync();
  });
  sync();
  saveBtn.addEventListener("click", () => void saveScript());
  bar.append(status, delBtn, saveBtn);
  wrap.append(area, bar);

  if (scriptError !== null) {
    const err = div("recon-error");
    err.textContent = scriptError;
    wrap.append(err);
  }
  return wrap;
}

function buildTestPanel(): HTMLElement {
  const wrap = div("recon-test");
  const h = document.createElement("h3");
  h.textContent = "Test";
  const hint = div("recon-test-hint");
  hint.textContent = "Runs the current source against one Jira issue.";

  const form = document.createElement("form");
  form.className = "recon-test-form";
  const input = document.createElement("input");
  input.className = "recon-input recon-test-key";
  input.type = "text";
  input.spellcheck = false;
  input.placeholder = "Issue key — e.g. PAY-101";
  input.setAttribute("aria-label", "Issue key to test the script against");
  input.value = testKey;
  const runBtn = document.createElement("button");
  runBtn.type = "submit";
  runBtn.className = "btn";
  runBtn.textContent = testing ? "Testing…" : "Test";
  const syncRun = (): void => {
    runBtn.disabled = testing || testKey.trim() === "";
  };
  input.addEventListener("input", () => {
    testKey = input.value;
    syncRun();
  });
  syncRun();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void runTest();
  });
  form.append(input, runBtn);
  wrap.append(h, hint, form);

  if (testError !== null) {
    const err = div("recon-error");
    err.textContent = testError;
    wrap.append(err);
  }
  if (testResult !== null) wrap.append(buildTestResult(testResult));
  return wrap;
}

const testStateLabels: Record<TrackerExtractorTest["state"], string> = {
  ok: "Extracted",
  skipped: "Skipped",
  notFound: "Not found",
  error: "Script error",
};

function buildTestResult(res: TrackerExtractorTest): HTMLElement {
  const wrap = div("recon-test-result");

  const resolved =
    res.state === "ok"
      ? resolveExtractedRange(res, state.current?.periods ?? [])
      : undefined;
  const resultState = resolved?.error ? "error" : res.state;

  const head = div("recon-test-head");
  const badge = document.createElement("span");
  badge.className = `recon-test-state ${resultState}`;
  badge.textContent = resolved?.error
    ? "Schedule error"
    : testStateLabels[resultState];
  head.append(badge);
  if (res.issue) {
    const key = document.createElement("a");
    key.className = "recon-issue-key";
    key.href = res.issue.url;
    key.target = "_blank";
    key.rel = "noreferrer";
    key.title = "Open in Jira";
    key.textContent = res.issue.key;
    const title = div("recon-test-title");
    title.textContent = res.issue.title;
    head.append(key, title);
  }
  wrap.append(head);

  const row = (label: string, value: string | Node): HTMLElement => {
    const el = div("recon-test-row");
    const name = document.createElement("span");
    name.className = "recon-test-label";
    name.textContent = label;
    const val = document.createElement("span");
    val.className = "recon-test-value";
    val.append(value);
    el.append(name, val);
    return el;
  };

  switch (resultState) {
    case "ok":
      wrap.append(row("Range", formatRange(resolved?.start, resolved?.end)));
      if (res.startPeriod || res.endPeriod) {
        const samePeriod = res.startPeriod === res.endPeriod;
        const periods = samePeriod
          ? res.startPeriod || res.endPeriod || "—"
          : `${res.startPeriod || "—"} to ${res.endPeriod || "—"}`;
        wrap.append(
          row(samePeriod ? "Period" : "Periods", periods),
        );
      }
      wrap.append(row("Label", res.label || "—"));
      break;
    case "skipped":
      wrap.append(row("Result", "No dates returned."));
      break;
    case "notFound":
      wrap.append(row("Result", "Issue not found or not visible."));
      break;
    case "error": {
      const msg = document.createElement("span");
      msg.className = "recon-test-error";
      msg.textContent = resolved?.error ?? res.error ?? "The script failed.";
      wrap.append(row("Error", msg));
      break;
    }
  }

  wrap.append(
    row("Fields", res.fields.length > 0 ? res.fields.join(", ") : "None"),
  );

  if (res.output && res.output.length > 0) {
    const out = document.createElement("pre");
    out.className = "recon-test-output";
    out.textContent = res.output.join("\n");
    wrap.append(subheading("Output"), out);
  }

  if (res.raw !== undefined) {
    const raw = document.createElement("pre");
    raw.className = "recon-test-raw";
    raw.textContent = JSON.stringify(res.raw, null, 2);
    wrap.append(subheading("Raw JSON"), raw);
  }
  return wrap;
}

function subheading(text: string): HTMLElement {
  const el = document.createElement("h4");
  el.className = "recon-test-subhead";
  el.textContent = text;
  return el;
}

function formatIsoDate(iso: string): string {
  return formatDay(dayOf(iso));
}

function formatRange(start?: string, end?: string): string {
  if (start && end) return `${formatIsoDate(start)} – ${formatIsoDate(end)}`;
  if (end) return `Ends ${formatIsoDate(end)}`;
  if (start) return `Starts ${formatIsoDate(start)}`;
  return "—";
}
