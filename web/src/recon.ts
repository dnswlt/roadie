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
import { diffTrackerIssues, type ReconciledIssue } from "./recon-diff";
import { createSearchList } from "./search-list";
import { state } from "./state";
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
// saving under a new name. Save… prefills its name and may only ever write
// THIS favourite: giving it another favourite's name is rejected by the
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
  ensureFavourites();
  const scrollTop = container.scrollTop;
  const prev = container.querySelector<HTMLInputElement>(".recon-input");
  const caret =
    prev && prev === document.activeElement
      ? { start: prev.selectionStart ?? prev.value.length, end: prev.selectionEnd ?? prev.value.length }
      : null;

  const root = div("recon");
  root.append(buildQueryForm(), ...buildResults());
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

function buildQueryForm(): HTMLElement {
  const head = div("recon-head");
  const h = document.createElement("h2");
  h.textContent = "Jira Reconciliation";
  head.append(h);

  const form = document.createElement("form");
  form.className = "recon-query";
  const input = document.createElement("input");
  input.className = "recon-input";
  input.type = "text";
  input.spellcheck = false;
  input.placeholder = "JQL — e.g. project = ROAD AND issuetype = Epic";
  input.value = query;
  const orderHelp = document.createElement("button");
  orderHelp.type = "button";
  orderHelp.className = "icon-btn recon-query-help";
  orderHelp.title = "How to order Jira results";
  orderHelp.setAttribute("aria-label", orderHelp.title);
  orderHelp.append(icons.help(18));
  orderHelp.addEventListener("click", () => openOrderingHelp());
  const runBtn = document.createElement("button");
  runBtn.type = "submit";
  runBtn.className = "btn btn-primary";
  runBtn.textContent = loading ? "Running…" : "Run";
  runBtn.disabled = loading;
  // "Save…" keeps a hard-won query; "Saved queries" brings one back. The
  // lightweight picker JIRA.md asks for: a small menu beside the editor, rows
  // that rerun on click, rename/delete on each row — no management page.
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn";
  saveBtn.textContent = "Save…";
  saveBtn.title = "Save this query under a name";
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
  form.append(buildFavPicker(), input, orderHelp, runBtn, saveBtn);
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

// Jira owns result ordering; Roadie preserves it rather than growing a second,
// subtly different sorting model. The small local help dialog gives the useful
// part of JQL's ORDER BY syntax at the point where it can be applied.
function openOrderingHelp(): void {
  const dlg = document.getElementById("dialog") as HTMLDialogElement;
  dlg.replaceChildren();

  const h = document.createElement("h3");
  h.textContent = "Order Jira issues";
  const body = div("recon-order-help");
  const intro = document.createElement("p");
  intro.textContent =
    "Roadie shows issues in the order Jira returns them. Prefer to build and test queries in Jira, then paste the JQL here. For a quick ordering change, add ORDER BY at the end:";
  body.append(intro);

  const examples = document.createElement("dl");
  examples.className = "recon-order-examples";
  const rows: [query: string, meaning: string][] = [
    ["ORDER BY updated DESC", "Most recently modified first"],
    ["ORDER BY summary", "Title from A to Z"],
    ["ORDER BY status, issueKey", "Status first, then issue key"],
  ];
  for (const [query, meaning] of rows) {
    const term = document.createElement("dt");
    const code = document.createElement("code");
    code.textContent = query;
    term.append(code);
    const description = document.createElement("dd");
    description.textContent = meaning;
    examples.append(term, description);
  }
  body.append(examples);

  const note = document.createElement("p");
  note.className = "recon-order-note";
  note.textContent = "Ascending is the default; add DESC to reverse it. Separate fields with commas.";
  body.append(note);

  const actions = div("dialog-actions");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-primary";
  close.textContent = "Close";
  close.addEventListener("click", () => dlg.close());
  actions.append(close);

  dlg.append(h, body, actions);
  dlg.showModal();
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
    btn.title = "No saved queries yet — run one and press Save";
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

function buildResults(): HTMLElement[] {
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
      for (const row of visible) list.append(issueRow(row));
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

// One result row: enough to identify the issue (key, summary, type, status),
// with the key linking out — opening an issue goes to Jira, never to a Roadie
// rendering of it.
function issueRow({ issue, matches }: ReconciledIssue): HTMLElement {
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
  add.className = "icon-btn recon-issue-add";
  add.title = `Link ${issue.key} to a Roadie item`;
  add.setAttribute("aria-label", add.title);
  add.append(icons.plus(14));
  add.addEventListener("click", () => {
    // No stopPropagation: popover.ts dismisses from the capture phase, so this
    // picker never sees the click that opened it.
    openIssuePicker(row, issue, new Set(matches.map((match) => match.itemId)));
  });
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
