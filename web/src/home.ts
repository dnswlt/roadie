// The Home dialog: every "which roadmap?" concern in one place — picking,
// previewing, creating, importing, and the trash. It replaces three scattered
// surfaces: the picker dropdown, the "Roadmap info" dialog, and the trash
// dialog, whose rendering it absorbed.
//
// The core interaction is select-then-act, not open-on-click: a single click
// previews a roadmap in the sidebar (the added value over the old dropdown —
// you can identify a roadmap by its contents *before* committing to it), a
// double click or the Open button opens it. The trash needs those semantics
// anyway, since a trashed roadmap cannot be opened at all (the server 404s it
// by design), only restored or purged.
//
// It owns its own <dialog id="home-dialog"> rather than the shared #dialog so
// the prompt/confirm primitives (dialogs.ts) can stack on top as nested modals:
// a purge confirm or the New prompt opens over Home and returns to it, with no
// close-and-reopen dance.

import { actions } from "./actions";
import { api } from "./api";
import { confirmDialog, newRoadmapDialog, promptDialog } from "./dialogs";
import { icons } from "./icons";
import { state } from "./state";
import { contentRange, formatDay } from "./timescale";
import { toast } from "./toast";
import type { Contributor, Roadmap, RoadmapFull, TrashedRoadmap } from "./types";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function dialogEl(): HTMLDialogElement {
  return document.getElementById("home-dialog") as HTMLDialogElement;
}

// --- Dialog-local state. Ephemeral by design: Home forgets its tab and
// selection on close, since "fresh list, current roadmap selected" is the
// right starting point of every visit.

type Tab = "roadmaps" | "trash";

let tab: Tab = "roadmaps";
let selectedId: number | null = null;
let trashEntries: TrashedRoadmap[] = [];
// previewToken invalidates in-flight preview fetches: clicking A then B fast
// must never let A's slower response overwrite B's sidebar.
let previewToken = 0;

// openHome refreshes both lists and shows the dialog. The roadmap list is
// re-fetched every time because it is deliberately not SSE-live — this is the
// moment a deletion or creation from another session becomes visible.
export async function openHome(): Promise<void> {
  try {
    await actions.loadRoadmaps();
    trashEntries = await api.listTrash();
  } catch (e) {
    toast(errMsg(e), true);
    return;
  }
  tab = "roadmaps";
  selectedId = state.current?.id ?? state.roadmaps[0]?.id ?? null;
  render();
  dialogEl().showModal();
}

// openRoadmap is the single exit into a roadmap: double click, Enter on a row,
// or the sidebar's Open button. selectRoadmap brings the URL, localStorage and
// SSE subscription along.
function openRoadmap(id: number): void {
  dialogEl().close();
  if (state.current?.id !== id) void actions.selectRoadmap(id);
}

function setTab(t: Tab): void {
  if (tab === t) return;
  tab = t;
  selectedId = t === "roadmaps" ? (state.roadmaps[0]?.id ?? null) : (trashEntries[0]?.id ?? null);
  render();
}

// refreshTrash re-fetches the trash after restore/purge and re-renders in
// place; Home stays open. The selection moves to the first remaining entry.
async function refreshTrash(): Promise<void> {
  try {
    trashEntries = await api.listTrash();
  } catch (e) {
    toast(errMsg(e), true);
  }
  if (!trashEntries.some((r) => r.id === selectedId)) {
    selectedId = trashEntries[0]?.id ?? null;
  }
  render();
}

// --- Rendering. render() rebuilds the whole dialog from the module state,
// mirroring the app's own "full re-render, no partial updates" principle.

function render(): void {
  const dlg = dialogEl();
  dlg.replaceChildren(tabsRow(), body(), footer());
}

function tabsRow(): HTMLElement {
  const row = document.createElement("div");
  row.className = "home-tabs";
  const mk = (t: Tab, label: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = tab === t ? "home-tab is-active" : "home-tab";
    b.textContent = label;
    b.addEventListener("click", () => setTab(t));
    return b;
  };
  // The count makes the trash findable: a tab that is usually empty is only
  // worth clicking when something is in it.
  row.append(
    mk("roadmaps", "Roadmaps"),
    mk("trash", trashEntries.length > 0 ? `Trash (${trashEntries.length})` : "Trash"),
  );
  return row;
}

function body(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "home-body";
  wrap.append(listPane(), sidePane());
  return wrap;
}

function listPane(): HTMLElement {
  const list = document.createElement("div");
  list.className = "home-list";

  const entries: Roadmap[] = tab === "roadmaps" ? state.roadmaps : trashEntries;
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = tab === "roadmaps" ? "No roadmaps yet." : "The trash is empty.";
    list.append(empty);
    return list;
  }

  for (const rm of entries) {
    const b = document.createElement("button");
    b.className = "menu-item home-row";
    if (rm.id === selectedId) b.classList.add("is-selected");
    // Bold + check for the roadmap open in the chart, as in the old dropdown.
    if (tab === "roadmaps" && state.current?.id === rm.id) b.classList.add("is-active");
    // The check marks the roadmap that is open in the chart behind the dialog,
    // not the row selected inside it — same glyph as the old dropdown.
    const mark = document.createElement("span");
    mark.className = "menu-check";
    if (tab === "roadmaps" && state.current?.id === rm.id) mark.append(icons.check(14));
    const name = document.createElement("span");
    name.className = "rm-item-name";
    name.textContent = rm.name;
    name.title = rm.name;
    b.append(mark, name);
    // A padlock marks the private ones. Only private is marked: public is the
    // default and by far the common case, so a globe on every other row would
    // be noise rather than information.
    if (rm.visibility === "private") {
      const lock = document.createElement("span");
      lock.className = "rm-item-lock";
      lock.title = "Private";
      lock.append(icons.lock(13));
      b.append(lock);
    }
    b.addEventListener("click", () => {
      if (selectedId === rm.id) return;
      selectedId = rm.id;
      render();
    });
    if (tab === "roadmaps") {
      b.addEventListener("dblclick", () => openRoadmap(rm.id));
    }
    list.append(b);
  }
  return list;
}

function sidePane(): HTMLElement {
  const side = document.createElement("div");
  side.className = "home-side";
  if (selectedId === null) {
    const hint = document.createElement("p");
    hint.className = "home-hint";
    hint.textContent =
      tab === "roadmaps"
        ? "Create a new roadmap or import an exported one."
        : "Nothing to restore.";
    side.append(hint);
    return side;
  }
  if (tab === "roadmaps") renderRoadmapSide(side, selectedId);
  else renderTrashSide(side, selectedId);
  return side;
}

// renderRoadmapSide fills the sidebar for a live roadmap: an Open button and
// the facts that used to be the "Roadmap info" dialog. Both fetches happen on
// selection — a roadmap payload is a few KB, and always fetching keeps one code
// path whether or not the selection is the currently open roadmap.
function renderRoadmapSide(side: HTMLElement, id: number): void {
  const rm = state.roadmaps.find((r) => r.id === id);
  if (!rm) return;

  side.append(sideTitle(rm.name));

  const actionsRow = document.createElement("div");
  actionsRow.className = "home-side-actions";
  const open = document.createElement("button");
  open.className = "btn btn-home";
  open.textContent = "Open";
  open.addEventListener("click", () => openRoadmap(id));
  actionsRow.append(open);
  side.append(actionsRow);

  const details = document.createElement("div");
  const loading = document.createElement("p");
  loading.className = "home-hint";
  loading.textContent = "Loading…";
  details.append(loading);
  side.append(details);

  const token = ++previewToken;
  void (async () => {
    try {
      const [full, authors] = await Promise.all([
        api.getRoadmap(id),
        api.listContributors(id).catch((): Contributor[] => []),
      ]);
      if (token !== previewToken) return; // a newer selection owns the pane
      details.replaceChildren(factsBlock(full, authors));
      if (authors.length > 0) details.append(authorsBlock(authors));
    } catch (e) {
      if (token !== previewToken) return;
      loading.textContent = errMsg(e);
    }
  })();
}

// renderTrashSide fills the sidebar for a trashed roadmap. No facts here: a
// trashed roadmap reads as absent from the API by design, so all there is to
// show is what the trash listing itself carries — and all there is to do is
// restore or purge.
function renderTrashSide(side: HTMLElement, id: number): void {
  const rm = trashEntries.find((r) => r.id === id);
  if (!rm) return;

  side.append(sideTitle(rm.name));

  const meta = document.createElement("p");
  meta.className = "home-meta";
  meta.textContent = `Deleted ${stamp(rm.deletedAt)} · ${countdown(rm.purgeAt)}`;
  side.append(meta);

  const row = document.createElement("div");
  row.className = "home-side-actions";

  const restore = document.createElement("button");
  restore.className = "btn";
  restore.textContent = "Restore";
  restore.addEventListener("click", () => {
    void (async () => {
      try {
        // Close first: restoring opens the roadmap, and a modal left standing
        // in front of it would hide the result of the click.
        dialogEl().close();
        await actions.restoreRoadmap(id);
      } catch (e) {
        toast(errMsg(e), true);
        void openHome(); // put Home back so the entry can be retried
      }
    })();
  });

  const purge = document.createElement("button");
  purge.className = "btn btn-danger";
  purge.textContent = "Delete permanently";
  purge.addEventListener("click", () => {
    void (async () => {
      // The confirm stacks on top of Home as a nested modal; Home stays open
      // throughout and just refreshes its list afterwards.
      const ok = await confirmDialog(
        `Permanently delete "${rm.name}"? This cannot be undone.`,
        "Delete permanently",
      );
      if (ok) {
        try {
          await api.purgeRoadmap(id);
          toast(`Permanently deleted "${rm.name}"`);
        } catch (e) {
          toast(errMsg(e), true);
        }
      }
      await refreshTrash();
    })();
  });

  row.append(restore, purge);
  side.append(row);
}

function footer(): HTMLElement {
  const row = document.createElement("div");
  row.className = "dialog-actions home-footer";

  const create = document.createElement("button");
  create.className = "btn";
  create.append(icons.plus(14), document.createTextNode("New"));
  // On an empty install the only sensible next step is creating a roadmap, so
  // showModal's initial focus lands there.
  if (state.roadmaps.length === 0) create.autofocus = true;
  create.addEventListener("click", () => {
    void (async () => {
      // The prompt stacks over Home; only an actual create closes it, since
      // createRoadmap opens the new roadmap. The visibility choice appears only
      // where it can be honoured: a private roadmap needs an owner, so an
      // anonymous creator has nothing to choose between.
      const req = await newRoadmapDialog(state.me.authenticated);
      if (req) {
        dialogEl().close();
        void actions.createRoadmap(req.name, req.visibility);
      }
    })();
  });

  const imp = document.createElement("button");
  imp.className = "btn";
  imp.append(icons.upload(14), document.createTextNode("Import"));
  imp.addEventListener("click", () => {
    (document.getElementById("rm-import-file") as HTMLInputElement).click();
  });

  const spacer = document.createElement("span");
  spacer.className = "spacer";

  const close = document.createElement("button");
  close.className = "btn";
  close.textContent = "Close";
  close.addEventListener("click", () => dialogEl().close());

  row.append(create, imp, spacer, close);
  return row;
}

// initHome wires the pieces that exist outside the dialog's own DOM: the file
// input the Import button triggers. Cancelling the file picker fires no change
// event, so Home simply stays open.
export function initHome(): void {
  const importFile = document.getElementById("rm-import-file") as HTMLInputElement;
  importFile.addEventListener("change", () => {
    const file = importFile.files?.[0];
    importFile.value = ""; // allow re-selecting the same file later
    if (file) {
      dialogEl().close(); // importRoadmap opens the imported roadmap
      void actions.importRoadmap(file);
    }
  });
}

// --- Shared rendering helpers (absorbed from the former info dialog).

function sideTitle(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.className = "home-side-title";
  h.textContent = text;
  h.title = text;
  return h;
}

// stamp renders an ISO timestamp in the app's British day-first, 24-hour
// convention, with the year — the dates here can be years apart, so the year
// is never redundant.
function stamp(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

// How many context names the facts row spells out before eliding; roughly two
// lines' worth of typical names in the 400px sidebar.
const MAX_CONTEXT_NAMES = 4;

// countdown says how long a trashed roadmap has left. Days, because that is
// the unit the retention policy is written in and a shrinking hour count is
// nothing anyone can act on faster.
function countdown(purgeAt: string): string {
  const days = Math.ceil((new Date(purgeAt).getTime() - Date.now()) / DAY_MS);
  if (days <= 0) return "due to be deleted";
  if (days === 1) return "1 day left";
  return `${days} days left`;
}

// countContents totals what the roadmap holds. Children count as items: they
// are items, and a total that skipped them would disagree with what the chart
// visibly contains. The flagged count rides along because open flags are a
// signal ("something in here needs attention"), not bookkeeping.
function countContents(rm: RoadmapFull): { items: number; milestones: number; flagged: number } {
  let items = 0;
  let milestones = 0;
  let flagged = 0;
  for (const lane of rm.lanes) {
    for (const item of lane.items) {
      items += 1 + item.children.length;
      if (item.flagged) flagged++;
      for (const c of item.children) if (c.flagged) flagged++;
    }
    milestones += lane.milestones.length;
  }
  return { items, milestones, flagged };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function factRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "info-row";
  const l = document.createElement("span");
  l.className = "info-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "info-value";
  v.textContent = value;
  row.append(l, v);
  return row;
}

// factsBlock renders what actually distinguishes one roadmap from another —
// the facts someone deciding "is this the one I want?" can act on. Raw counts
// are deliberately demoted to a single size line: "20 items" tells nobody
// anything, whereas *when* it lives (timespan), *whether it is alive* (last
// edited), and *what it is about* (the context names) do.
function factsBlock(rm: RoadmapFull, authors: Contributor[]): HTMLElement {
  const facts = document.createElement("div");
  facts.className = "info-facts";

  const range = contentRange(rm.lanes);
  facts.append(
    factRow("Timespan", range ? `${formatDay(range.startDay)} – ${formatDay(range.endDay)}` : "—"),
  );

  // Who can see it. Shown only for private roadmaps, for the same reason the
  // list only marks those: "Visible to: Everyone" on every row is not a fact
  // anyone is deciding between roadmaps on.
  if (rm.visibility === "private") {
    facts.append(factRow("Visible to", rm.owned ? "Only you" : "Its members"));
  }

  // "Last edited" is derived from the contributors (the authors table below is
  // alphabetical, so this is not readable from it at a glance). It is the
  // staleness check: the difference between the active roadmap and last year's
  // copy of it. roadmaps.updated_at cannot answer this — it only moves when the
  // roadmap row itself is written (a rename or a restore), not on edits to the
  // lanes, items and milestones the roadmap actually consists of.
  const last = authors.reduce<Contributor | null>(
    // Compare as dates: the ISO strings may carry differing UTC offsets, so
    // string order is not time order.
    (a, c) => (a === null || Date.parse(c.lastSeen) > Date.parse(a.lastSeen) ? c : a),
    null,
  );
  if (last) facts.append(factRow("Last edited", `${stamp(last.lastSeen)} by ${last.name}`));
  facts.append(factRow("Created", stamp(rm.createdAt)));

  // The context *names*, not their count — they are the closest thing to a
  // table of contents the model has. Capped: the first few names carry the
  // "what is this about" signal, and ten of them would drown the other facts.
  // The count in the ellipsis keeps the total readable off the row.
  const laneNames = rm.lanes.map((l) => l.name);
  const shown = laneNames.slice(0, MAX_CONTEXT_NAMES).join(", ");
  const more = laneNames.length - MAX_CONTEXT_NAMES;
  const contexts = factRow("Contexts", more > 0 ? `${shown}, … (${laneNames.length})` : shown || "—");
  // The full list is one hover away.
  if (more > 0) contexts.title = laneNames.join(", ");
  facts.append(contexts);

  const { items, milestones, flagged } = countContents(rm);
  facts.append(factRow("Size", `${plural(items, "item")} · ${plural(milestones, "milestone")}`));
  // Open flags mean "something in here needs attention" — worth a row, but
  // only when there are any; "Flagged: 0" would be noise on every roadmap.
  if (flagged > 0) facts.append(factRow("Flagged", plural(flagged, "item")));

  // "Standard" = the plain calendar grid (quarters/months); a schedule swaps
  // that for named sprint/PI periods.
  facts.append(
    factRow("Schedule", rm.periods.length > 0 ? plural(rm.periods.length, "period") : "Standard"),
  );
  return facts;
}

// authorsBlock lists everyone who has edited the roadmap with the window over
// which they did. Rows arrive alphabetically from the server and stay that way:
// ordering by activity would read as a ranking of who contributed most, which
// is not a claim this data supports. With auth off nobody is ever recorded and
// the caller skips the block entirely.
function authorsBlock(cs: Contributor[]): HTMLElement {
  const wrap = document.createElement("div");
  const h = document.createElement("h4");
  h.className = "info-section";
  h.textContent = cs.length === 1 ? "Author" : "Authors";

  const table = document.createElement("table");
  table.className = "info-authors";
  const head = document.createElement("tr");
  for (const t of ["Author", "First edit", "Last edit"]) {
    const th = document.createElement("th");
    th.textContent = t;
    head.append(th);
  }
  table.append(head);
  for (const c of cs) {
    const tr = document.createElement("tr");
    for (const text of [c.name, stamp(c.firstSeen), stamp(c.lastSeen)]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    table.append(tr);
  }

  // Scroll the author list rather than the sidebar, keeping the facts and the
  // Open button in place however many authors there are.
  const scroller = document.createElement("div");
  scroller.className = "info-authors-scroll";
  scroller.append(table);
  wrap.append(h, scroller);
  return wrap;
}
