// The Jira Recon view (notes/JIRA.md): run a user-supplied JQL query against
// the deployment's tracker connection and list the issues it returns, one
// explicitly fetched page at a time — "Load more" is the only way to another
// page, so a single action can never download a whole Jira deployment.
//
// Everything here is view-local module state, deliberately outside AppState:
// tracker results are not roadmap content (not snapshotted, not exported, not
// rendered by any chart view). The state survives view switches — leaving and
// returning shows the same loaded results — but not a reload.
//
// Rendering follows render.ts/wbs.ts: full rebuild from state on every call.
// The one editable field, the query input, gets the panel's courtesy: its text
// lives in `query` (synced on input) and its caret/focus are restored across a
// rebuild, so an SSE refresh landing mid-typing cannot eat a half-written
// query.

import { actions } from "./actions";
import { api } from "./api";
import { laneColorValue } from "./colors";
import { confirmDialog, promptDialog } from "./dialogs";
import { icons } from "./icons";
import { appendLinkToDescription } from "./links";
import { openPopover, type PopoverHandle } from "./popover";
import {
  diffTrackerIssues,
  roadieItemsWithoutJiraReference,
  type ReconciledIssue,
  type UnreferencedRoadieItem,
} from "./recon-diff";
import { createSearchList } from "./search-list";
import { state, type ItemLocation } from "./state";
import { toast } from "./toast";
import type { TrackerIssue, TrackerQuery } from "./types";

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
// The two reconciliation questions are peers, but only Jira issues have query
// controls. Keeping this local matches the rest of Recon's ephemeral UI state
// and makes the Roadie list independent of whichever JQL was last run.
let section: "issues" | "roadie" = "issues";
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
  if (mount && state.viewMode === "recon") renderRecon(mount);
}

// Reset the cross-tab operation without touching AppState: linking is local
// Recon UI state. Returning to the Roadie list makes every exit land where the
// operation started.
function resetLinkMode(): boolean {
  if (linkTarget === null) return false;
  linkTarget = null;
  linkingIssueKey = null;
  section = "roadie";
  return true;
}

// Explicit in-view cancellation (button / Escape) needs a repaint.
export function cancelReconLinkMode(): boolean {
  // A mode that is temporarily off-screen is not an Escape target. This lets
  // somebody inspect WBS/timeline and return without losing the operation,
  // while Escape in those views retains its ordinary editing meaning.
  if (state.viewMode !== "recon") return false;
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
  if (section === "issues") ensureFavourites();
  const scrollTop = container.scrollTop;
  const prev = container.querySelector<HTMLInputElement>(".recon-input");
  const caret =
    prev && prev === document.activeElement
      ? { start: prev.selectionStart ?? prev.value.length, end: prev.selectionEnd ?? prev.value.length }
      : null;

  const root = div("recon");
  const unreferenced = roadieItemsWithoutJiraReference(state.current);
  // Resolved once per render: the lookup also drops a target that has since
  // vanished, which every issue row would otherwise repeat.
  const target = currentLinkTarget();
  root.append(buildHeader(unreferenced.length));
  if (section === "issues") {
    const banner = buildLinkModeBanner(target);
    if (banner) root.append(banner);
    root.append(buildQueryForm(), ...buildResults(target));
  } else root.append(...buildRoadieResults(unreferenced));
  container.replaceChildren(root);

  container.scrollTop = scrollTop;
  if (caret) {
    const input = container.querySelector<HTMLInputElement>(".recon-input");
    if (input) {
      input.focus();
      input.setSelectionRange(caret.start, caret.end);
    }
  }
}

function buildHeader(unreferencedCount: number): HTMLElement {
  const head = div("recon-head");
  const h = document.createElement("h2");
  h.textContent = "Jira Reconciliation";
  head.append(h);

  const tabs = document.createElement("nav");
  tabs.className = "recon-tabs";
  tabs.setAttribute("aria-label", "Reconciliation lists");
  const choices: { id: typeof section; label: string; count?: number }[] = [
    { id: "issues", label: "Jira issues" },
    { id: "roadie", label: "Roadie items", count: unreferencedCount },
  ];
  for (const choice of choices) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = choice.id === section ? "recon-tab active" : "recon-tab";
    tab.setAttribute("aria-pressed", String(choice.id === section));
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
      if (choice.id === section) return;
      closePicker();
      issuePicker?.close();
      section = choice.id;
      rerender();
    });
    tabs.append(tab);
  }
  head.append(tabs);
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
  open.addEventListener("click", () => state.revealAndSelect("item", item.itemId));
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
    section = "issues";
    // Besides opening the edit rail, this keeps the target highlighted when
    // the user returns to WBS/timeline after linking.
    state.revealAndSelect("item", item.itemId);
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
      item.addEventListener("click", () => state.revealAndSelect("item", match.itemId));
      linked.append(item);
    }
    row.append(linked);
  }
  return row;
}
