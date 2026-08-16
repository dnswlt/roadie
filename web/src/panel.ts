// The edit side-panel for the selected item. Values are committed on
// change (blur / Enter / date pick); structural actions (add child,
// delete) go through actions.ts.

import { actions } from "./actions";
import { copyText } from "./clipboard";
import { laneColorValue } from "./colors";
import { dependenciesSection, depsGraphButton } from "./deps";
import { confirmDialog } from "./dialogs";
import { icons } from "./icons";
import { extractLinks } from "./links";
import { itemMarkdown } from "./markdown";
import { periodAtEdge, periodDates, periodsByStart } from "./schedule";
import { state, type MilestoneLocation } from "./state";
import type { Item, ItemFull, LaneFull, Milestone, SchedulePeriod } from "./types";
import { selectionLink } from "./url";

const PANEL_TITLE_ID = "panel-item-title";

// confirmAndDeleteItems / confirmAndDeleteMilestone are the delete flow behind
// both the panel's Delete button and the Del keyboard shortcut: confirm, then
// delegate to actions. Keeping them shared means the shortcut is exactly the
// button — and that one item and many go through the same prompt, so the two
// wordings can't drift.
//
// The count in the prompt includes children, since deleting a parent takes
// them with it and that is not visible from the selection alone. Selected
// items are always in disjoint containers (state.toggleItem drops a child when
// its parent is selected), so children are never double-counted.
async function confirmAndDeleteItems(items: Item[]): Promise<void> {
  if (items.length === 0) return;
  const kids = items.reduce((n, it) => n + ((it as ItemFull).children?.length ?? 0), 0);
  const msg =
    items.length === 1
      ? `Delete "${items[0]!.title}"${kids > 0 ? ` and its ${kids} child item(s)` : ""}?`
      : `Delete ${items.length} items${kids > 0 ? ` and their ${kids} child item(s)` : ""}?`;
  if (await confirmDialog(msg)) {
    void actions.deleteItems(items.map((it) => it.id));
  }
}

function confirmAndDeleteItem(item: Item): Promise<void> {
  return confirmAndDeleteItems([item]);
}

async function confirmAndDeleteMilestone(milestone: Milestone): Promise<void> {
  if (await confirmDialog(`Delete milestone "${milestone.title}"?`)) {
    void actions.deleteMilestone(milestone.id);
  }
}

// deleteSelection deletes everything selected: one milestone, one item, or a
// whole multi-selection of items. Deleting is a **per-item** operation like
// flagging — "delete these five" is unambiguous — so unlike `n`/`c` it does not
// need a single target. Only the shortcut reaches the multi case: the edit
// panel (and its Delete button) shows nothing while several items are selected.
// No-op with an empty selection, or while previewing a snapshot (read-only).
export function deleteSelection(): void {
  if (state.preview) return;
  const msId = state.selectedMilestoneId;
  if (msId !== null) {
    const loc = state.findMilestone(msId);
    if (loc) void confirmAndDeleteMilestone(loc.milestone);
    return;
  }
  const items = [...state.selectedItemIds]
    .map((id) => state.findItem(id)?.item)
    .filter((it) => it !== undefined);
  if (items.length > 0) void confirmAndDeleteItems(items);
}

// addSiblingOf creates an item beside `item`: same container, same dates,
// positioned directly after it. `parentId` already names the container (null =
// top level in the lane) and `rank` is the index within it, so the whole
// placement falls out of the item itself.
//
// This is the single implementation behind both the panel's "+ Add sibling"
// buttons and the "n" shortcut — the two must never drift apart, which is the
// only reason a one-line function earns a name.
function addSiblingOf(item: Item): Promise<Item | null> {
  return actions.addItem(item.laneId, item.parentId, {
    dates: { start: item.startDate, end: item.endDate },
    rank: item.rank + 1,
  });
}

// addChildTo creates a child item inside `item`, appending it to the parent's
// children array. Nesting is one level deep, so this only operates on top-level
// items (where parentId is null).
//
// This is the single implementation behind both the panel's "Add Child" button
// and the "c" shortcut — matching the twin structure of addSiblingOf and "n".
function addChildTo(item: Item): Promise<Item | null> {
  if (item.parentId !== null) return Promise.resolve(null);
  return actions.addItem(item.laneId, item.id);
}

// addItemToSelection is the "n" shortcut: create an item beside the selection,
// in the selection's own container. A child's container is its parent, so a
// selected child yields another subtask, while a top-level item yields a
// top-level sibling in its lane — one rule, "new thing beside this thing".
//
// A selected milestone falls back to a plain top-level item appended to its
// lane, since a milestone has no item sibling to sit beside — the same thing
// the lane's + button does. Needs exactly one target, like deleteSelection:
// "beside this" is meaningless for a multi-selection that may span containers.
export async function addItemToSelection(): Promise<void> {
  if (state.preview) return;

  const msId = state.selectedMilestoneId;
  if (msId !== null) {
    const ms = state.findMilestone(msId);
    if (ms && (await actions.addItem(ms.lane.id, null))) focusPanelTitle();
    return;
  }

  const id = state.selectedItemId;
  if (id === null) return;
  const loc = state.findItem(id);
  if (!loc) return;
  if (await addSiblingOf(loc.item)) focusPanelTitle();
}

// addChildToSelection is the "c" shortcut: create a child item under the
// selected top-level item. Nesting is one level deep, so "c" no-ops on a
// selected child (addChildTo's own guard), matching the absence of an "Add
// Child" button on its edit panel. Needs exactly one target, like
// addItemToSelection — and needs no milestone check of its own, since selection
// is exclusive: a selected milestone leaves no item selected, so it falls out
// of the single-target check below.
export async function addChildToSelection(): Promise<void> {
  if (state.preview) return;

  const id = state.selectedItemId;
  if (id === null) return;
  const loc = state.findItem(id);
  if (!loc) return;
  if (await addChildTo(loc.item)) focusPanelTitle();
}

// focusPanelTitle drops the cursor into the edit panel's Title field with the
// text pre-selected, so "n" flows straight into typing the real title. Its
// callers are the create paths and the rename gestures (double-click a bar or
// milestone, or "e") — the panel's own + buttons leave focus where it was.
// Safe to call right after the notify that (re)rendered the panel: that happens
// synchronously, so the field already exists.
//
// This is also the one thing that reopens a collapsed rail, and the line worth
// holding: *selecting* never reopens it, because browsing a roadmap is not
// editing it and a rail that springs back on every click is the popping panel
// we replaced. But every caller here has already put the user in an editing
// context — a new item waiting to be named, a rename they asked for — so a
// collapsed rail would silently swallow the action. Revealing is skipped while
// version history owns the side, where it could not take effect anyway and
// would only leave a surprise behind for when they return.
export function focusPanelTitle(): void {
  if (state.panelCollapsed && state.history === null) setPanelCollapsed(false);
  const el = document.getElementById(PANEL_TITLE_ID);
  if (!(el instanceof HTMLInputElement)) return;
  el.focus();
  el.select();
}

// editSelection is the "e" shortcut: put the cursor in the selected thing's
// title. The mouse twin is double-clicking a bar or a milestone, so both go
// through focusPanelTitle and can't drift.
//
// Needs exactly one target, like "n" and "c": selectedItemId is null for a
// multi-selection, so "e" no-ops there rather than picking a title arbitrarily.
// The guard also keeps a stray "e" from reopening the rail with nothing in it.
export function editSelection(): void {
  if (state.preview) return;
  if (state.selectedMilestoneId === null && state.selectedItemId === null) return;
  focusPanelTitle();
}

// toggleFlagSelection flags or unflags every selected item, behind the panel
// chip and the "!" shortcut. Unlike deleteSelection it embraces a
// multi-selection: flagging the handful of items a discussion just surfaced is
// the whole point. Mixed selections flag (rather than unflag), so the first
// press always marks everything; only an all-flagged selection clears.
export function toggleFlagSelection(): void {
  if (state.preview) return;
  const ids = [...state.selectedItemIds];
  if (ids.length === 0) return;
  const items = ids.map((id) => state.findItem(id)?.item).filter((it) => it !== undefined);
  if (items.length === 0) return;
  const next = !items.every((it) => it.flagged);
  void actions.setFlagged(
    items.map((it) => it.id),
    next,
  );
}

// copyLinkButton builds a "copy shareable link" icon button for the panel head.
// The link is generated on demand from the current roadmap + this selection —
// the address bar itself never carries the selection (see url.ts).
function copyLinkButton(kind: "item" | "milestone", id: number): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "icon-btn";
  btn.title = "Copy link";
  btn.append(icons.link(16));
  btn.addEventListener("click", () => {
    const roadmap = state.current;
    if (!roadmap) return;
    void copyText(selectionLink(roadmap, kind, id), "Link");
  });
  return btn;
}

// copyMarkdownButton copies the selected item as Markdown — the chart is the one
// part of a roadmap you cannot paste into a chat, an issue, or a prompt. Sits
// beside the link button: both answer "get this out of Roadie", one as a
// reference and one as content.
function copyMarkdownButton(item: Item, lane: LaneFull, parent: ItemFull | null): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "icon-btn";
  btn.title = "Copy as Markdown";
  btn.append(icons.copy(16));
  btn.addEventListener("click", () => {
    const roadmap = state.current;
    if (!roadmap) return;
    void copyText(itemMarkdown(roadmap, lane, item, parent), "Markdown");
  });
  return btn;
}

// Identifies what the panel currently shows, e.g. "item:5" or "ms:3", so a
// re-render can skip rebuilding the panel under the user's cursor.
let renderedKey: string | null = null;

// The panel element, captured on render so flushPendingEdit can find it.
let panelEl: HTMLElement | null = null;

// flushPendingEdit commits whatever panel field the user is still typing in.
// Fields save on `change`, which fires only on blur. Esc uses this to finish an
// edit while retaining the selection; Close uses it before tearing the panel
// down, since an element removed from the DOM fires neither blur nor change.
// Blurring here fires `change` synchronously, so the field's own commit handler
// does the saving and no second save path exists.
export function flushPendingEdit(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && panelEl?.contains(el)) el.blur();
}

// closeButton deselects, which closes the panel. Pressing it must not blur the
// focused field: the field's change handler would re-render the panel and
// destroy this button before its click could fire (save without close). The
// click handler flushes instead, so save-and-close is one click everywhere.
function closeButton(): HTMLButtonElement {
  const close = document.createElement("button");
  close.className = "icon-btn";
  close.title = "Clear selection";
  close.append(icons.x());
  close.addEventListener("mousedown", (e) => e.preventDefault());
  close.addEventListener("click", () => {
    flushPendingEdit();
    state.clearSelection();
    state.notifySelection();
  });
  return close;
}

// setPanelCollapsed is the only thing that changes the rail's presence, so the
// persistence lives with it rather than in app.ts (which reads it back at boot).
// notifySelection is the right scope: the rail's width is not chart geometry —
// bar positions come from the zoom, not from how much room is left.
function setPanelCollapsed(collapsed: boolean): void {
  state.panelCollapsed = collapsed;
  localStorage.setItem("roadie.panelCollapsed", collapsed ? "1" : "0");
  state.notifySelection();
}

// togglePanel is the "p" shortcut, the keyboard twin of the toggle strip. No
// flushPendingEdit, unlike the strip's own click: "p" cannot fire while a panel
// field has focus (keys.ts suppresses bare-letter shortcuts in text fields), and
// a field that has lost focus has already committed on `change`.
//
// Ignored while version history owns the side, where it would change nothing on
// screen and leave the rail in an unexpected state on the way back — the same
// reason focusPanelTitle does not reveal there.
export function togglePanel(): void {
  if (state.history !== null) return;
  setPanelCollapsed(!state.panelCollapsed);
}

// toggleStrip is the rail's outer edge: a full-height gutter that is itself the
// button, with the chevron flipping to say which way it goes. It is furniture —
// always present, never rebuilt by a view — so collapsing and expanding are one
// control that never moves, rather than two that have to be lined up.
//
// Lightroom puts this strip on the panel's inner edge; here that edge belongs to
// the resize handle, and the outer edge is steadier anyway: it is the window's
// edge, so it stays put whatever the rail's width.
function toggleStrip(collapsed: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "panel-toggle";
  b.title = collapsed ? "Show panel" : "Collapse panel";
  b.append(collapsed ? icons.chevronLeft(16) : icons.chevronRight(16));
  // Same reason as closeButton: don't blur the focused field before the click.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    flushPendingEdit();
    setPanelCollapsed(!collapsed);
  });
  return b;
}

// railHead builds the header every view shares: what you are looking at on the
// left, its actions on the right.
function railHead(kindText: string, ...actions: HTMLElement[]): HTMLElement {
  const head = document.createElement("div");
  head.className = "panel-head";
  const kind = document.createElement("span");
  kind.className = "panel-kind";
  kind.textContent = kindText;
  const headActions = document.createElement("div");
  headActions.className = "panel-head-actions";
  headActions.append(...actions);
  head.append(kind, headActions);
  return head;
}

// railBody returns the element the views render into, rebuilding the rail's
// structure ([body][toggle]) when it isn't there — which is the case on first
// render and whenever the collapsed strip has replaced it.
function railBody(panel: HTMLElement): HTMLElement {
  const existing = panel.querySelector<HTMLElement>(":scope > .panel-body");
  if (existing) return existing;
  const body = document.createElement("div");
  body.className = "panel-body";
  panel.replaceChildren(body, toggleStrip(false));
  return body;
}

// noteBlock is what the rail shows when there are no fields to show: a line
// saying where you are and a line saying how to get somewhere useful.
function noteBlock(title: string, hint: string): HTMLElement {
  const note = document.createElement("div");
  note.className = "panel-note";
  const t = document.createElement("p");
  t.className = "panel-note-title";
  t.textContent = title;
  const h = document.createElement("p");
  h.className = "panel-note-hint";
  h.textContent = hint;
  note.append(t, h);
  return note;
}

// renderEmptyRail: nothing selected. The rail says so and holds its place,
// which is the whole point — the alternative is the chart jumping every time
// you click empty canvas.
function renderEmptyRail(body: HTMLElement): void {
  if (renderedKey === "empty") return;
  renderedKey = "empty";
  // No head: there is no kind of thing being shown and nothing to act on. The
  // toggle strip is furniture outside the body, so it is unaffected.
  body.replaceChildren(noteBlock("Nothing selected", "Pick an item or milestone to edit it."));
  // Drop the last item's lane accent; nothing here should still be wearing it.
  body.style.removeProperty("--c");
}

// commonValue reports the value every item shares, and whether they differ at
// all — `mixed`, the third display state the bulk controls need.
function commonValue<T>(items: Item[], value: (item: Item) => T): { value: T; mixed: boolean } {
  const first = value(items[0]!);
  return { value: first, mixed: items.some((item) => !Object.is(value(item), first)) };
}

// renderSelectionPanel offers only scalar metadata whose bulk meaning is
// mechanical: one explicit value is applied to every selected item. Labels and
// dependencies stay single-item operations — their partial/common state and
// edge ownership would turn this small editor into a batch-management system.
function renderSelectionPanel(body: HTMLElement): void {
  const items = [...state.selectedItemIds]
    .map((id) => state.findItem(id)?.item)
    .filter((item) => item !== undefined);
  const ids = items.map((item) => item.id);
  const n = items.length;
  // Always rebuilt, unlike the item view: the controls below capture their
  // state at build time, so nothing here may start skipping the rebuild.
  // Safe — the view is all buttons, so there is no in-progress edit to eat.
  renderedKey = "multi";
  body.replaceChildren();
  body.style.removeProperty("--c");

  const note = noteBlock(`${n} items selected`, "Changes below apply to every selected item.");

  const priority = commonValue(items, (item) => item.priority);
  const prio = document.createElement("div");
  prio.className = "panel-field";
  const prioLabel = document.createElement("span");
  prioLabel.textContent = priority.mixed ? "Priority · Mixed" : "Priority";
  const chips = document.createElement("div");
  chips.className = "prio-chips";
  for (let p = 1; p <= 4; p++) {
    const chip = document.createElement("button");
    chip.className = "prio-chip";
    chip.textContent = `P${p}`;
    const active = !priority.mixed && priority.value === p;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", String(active));
    chip.addEventListener("click", () => {
      void actions.updateItemMetadata(ids, { priority: active ? null : p });
    });
    chips.append(chip);
  }

  const signalState = (field: "tentative" | "atRisk" | "flagged"): boolean | "mixed" => {
    const common = commonValue(items, (item) => item[field]);
    return common.mixed ? "mixed" : common.value;
  };
  const signals = document.createElement("div");
  signals.className = "signal-btns";
  signals.append(
    metadataSignalButton(
      "tent-btn",
      "Tentative timing: dates are not a precise commitment",
      icons.approx(16),
      signalState("tentative"),
      (tentative) => void actions.updateItemMetadata(ids, { tentative }),
    ),
    metadataSignalButton(
      "risk-btn",
      "At risk: the plan stands, but there is reason to doubt it",
      icons.alertTriangle(16),
      signalState("atRisk"),
      (atRisk) => void actions.updateItemMetadata(ids, { atRisk }),
    ),
    metadataSignalButton(
      "flag-btn",
      "Flag: needs attention (!)",
      icons.flag(16),
      signalState("flagged"),
      (flagged) => void actions.setFlagged(ids, flagged),
    ),
  );
  const prioRow = document.createElement("div");
  prioRow.className = "prio-row";
  prioRow.append(chips, signals);
  prio.append(prioLabel, prioRow);

  const attrs = document.createElement("div");
  attrs.className = "panel-attrs multi-meta";
  attrs.append(prio);

  const actionsRow = document.createElement("div");
  actionsRow.className = "panel-actions";
  actionsRow.append(deleteButton(`Delete ${n} items`, () => deleteSelection()));

  body.append(railHead("Selection", closeButton()), note, attrs, actionsRow);
}

interface DateEditorRows {
  dateRow: HTMLElement;
  periodRow: HTMLElement | null;
}

type ItemDates = Pick<Item, "startDate" | "endDate">;

// itemDateEditor owns the four controls that edit one date range: two native
// date inputs and, when the roadmap has a schedule, the two period selects
// beneath them. `value` is their one shared state. Every edit passes through
// show (synchronize all four controls) and commit (send one minimal patch), so
// neither the DOM nor the item captured by render has to masquerade as the
// latest value while the focused panel deliberately skips rebuilds.
function itemDateEditor(item: Item): DateEditorRows {
  const dates = document.createElement("div");
  dates.className = "panel-row";
  const start = field("Start", "input");
  const startInput = start.control as HTMLInputElement;
  startInput.type = "date";
  const end = field("End", "input");
  const endInput = end.control as HTMLInputElement;
  endInput.type = "date";
  dates.append(start.wrap, end.wrap);

  const periods = periodsByStart(state.current?.periods ?? []);
  let value: ItemDates = { startDate: item.startDate, endDate: item.endDate };
  let startPeriod: HTMLSelectElement | null = null;
  let endPeriod: HTMLSelectElement | null = null;

  const show = (next: ItemDates): void => {
    value = next;
    startInput.value = next.startDate;
    endInput.value = next.endDate;
    if (startPeriod) {
      startPeriod.value = periodAtEdge(periods, "start", next.startDate)?.id.toString() ?? "";
    }
    if (endPeriod) {
      endPeriod.value = periodAtEdge(periods, "end", next.endDate)?.id.toString() ?? "";
    }
  };
  const commit = (next: ItemDates): void => {
    const previous = value;
    show(next);
    const patch: { startDate?: string; endDate?: string } = {};
    if (next.startDate !== previous.startDate) patch.startDate = next.startDate;
    if (next.endDate !== previous.endDate) patch.endDate = next.endDate;
    if (patch.startDate || patch.endDate) void actions.updateItem(item.id, patch);
  };
  const edit = (edge: "start" | "end", input: HTMLInputElement): void => {
    if (!input.value) return;
    commit(
      edge === "start"
        ? { startDate: input.value, endDate: value.endDate }
        : { startDate: value.startDate, endDate: input.value },
    );
  };

  startInput.addEventListener("change", () => edit("start", startInput));
  endInput.addEventListener("change", () => edit("end", endInput));

  let periodRowElement: HTMLElement | null = null;
  if (periods.length > 0) {
    startPeriod = periodSelect("Start period", periods, (p) =>
      commit(periodDates("start", p, value)),
    );
    endPeriod = periodSelect("End period", periods, (p) => commit(periodDates("end", p, value)));
    periodRowElement = periodRow(startPeriod, endPeriod);
  }
  show(value);
  return { dateRow: dates, periodRow: periodRowElement };
}

// milestoneDateEditor is the point-date twin of itemDateEditor. The same local
// value drives both the native input and its optional "Due in" period select.
function milestoneDateEditor(milestone: Milestone): DateEditorRows {
  const fieldRow = field("Date", "input");
  const input = fieldRow.control as HTMLInputElement;
  input.type = "date";
  const periods = periodsByStart(state.current?.periods ?? []);
  let value = milestone.date;
  let duePeriod: HTMLSelectElement | null = null;

  const show = (next: string): void => {
    value = next;
    input.value = next;
    if (duePeriod) {
      duePeriod.value = periodAtEdge(periods, "end", next)?.id.toString() ?? "";
    }
  };
  const commit = (next: string): void => {
    const previous = value;
    show(next);
    if (next !== previous) void actions.updateMilestone(milestone.id, { date: next });
  };

  input.addEventListener("change", () => {
    if (input.value) commit(input.value);
  });

  let periodRowElement: HTMLElement | null = null;
  if (periods.length > 0) {
    // A milestone due in a period lands on its last day: it is a deadline, not
    // work spanning that period.
    duePeriod = periodSelect("Due in period", periods, (p) => commit(p.endDate));
    periodRowElement = periodRow(duePeriod);
  }
  show(value);
  return { dateRow: fieldRow.wrap, periodRow: periodRowElement };
}

// renderPanel routes the rail to one of four views. The rail itself is a
// fixture — it holds its width whatever is selected, so selecting and
// deselecting never resizes the chart out from under you. Only two things ever
// take it away: collapsing it by hand, and version history, which owns the
// right-hand side while you browse.
export function renderPanel(panel: HTMLElement): void {
  panelEl = panel;
  // While browsing version history the right side belongs to the history list,
  // and a snapshot preview is read-only — so the edit rail stows entirely.
  if (state.history !== null) {
    panel.classList.remove("open", "collapsed");
    panel.style.width = "";
    panel.replaceChildren();
    renderedKey = null;
    return;
  }

  // Collapsed, the strip is the whole rail. Selecting something does not expand
  // it — a rail that reopens on selection is the popping panel this replaces.
  if (state.panelCollapsed) {
    panel.classList.remove("open");
    panel.classList.add("collapsed");
    panel.style.width = "";
    if (renderedKey === "collapsed") return;
    renderedKey = "collapsed";
    panel.replaceChildren(toggleStrip(true));
    panel.style.removeProperty("--c");
    return;
  }

  panel.classList.remove("collapsed");
  panel.classList.add("open");
  panel.style.width = `${state.panelWidth}px`;
  const body = railBody(panel);

  const msId = state.selectedMilestoneId;
  const msLoc = msId !== null ? state.findMilestone(msId) : null;
  if (msLoc) {
    renderMilestonePanel(body, msLoc);
    return;
  }

  const id = state.selectedItemId;
  const loc = id !== null ? state.findItem(id) : null;

  if (!loc) {
    // selectedItemId is null for a multi-selection too, so the two empty-ish
    // views are distinguished here rather than by the absence of an item.
    if (state.hasMultiSelection()) renderSelectionPanel(body);
    else renderEmptyRail(body);
    return;
  }

  // Don't rebuild under the user's cursor while they are typing.
  const key = `item:${loc.item.id}`;
  if (renderedKey === key && panel.contains(document.activeElement)) {
    return;
  }
  renderedKey = key;
  body.replaceChildren();

  const { item, lane, parent } = loc;
  // Tie the panel's accent (priority chips) to the item's lane color.
  body.style.setProperty("--c", laneColorValue(lane.color));

  const head = railHead(
    parent ? "Child item" : "Item",
    depsGraphButton({ kind: "item", id: item.id }),
    copyMarkdownButton(item, lane, parent),
    copyLinkButton("item", item.id),
    closeButton(),
  );

  const crumb = crumbLine(parent ? `${lane.name} › ${parent.title}` : lane.name);

  const title = titleField(item.title);
  // Stable hook for focusPanelTitle — the panel has several .panel-field
  // inputs, so the Title one needs to be addressable by more than position.
  title.control.id = PANEL_TITLE_ID;
  title.control.addEventListener("change", () => {
    const v = title.control.value.trim();
    if (v && v !== item.title) void actions.updateItem(item.id, { title: v });
  });

  const desc = field("Description", "textarea");
  (desc.control as HTMLTextAreaElement).value = item.description;
  desc.control.addEventListener("change", () => {
    const v = (desc.control as HTMLTextAreaElement).value;
    if (v !== item.description) void actions.updateItem(item.id, { description: v });
  });

  const linksSection = createLinksSection(desc.control as HTMLTextAreaElement);

  const dates = itemDateEditor(item);

  // Priority: four chips (P1 highest .. P4 lowest). Clicking the active chip
  // clears the priority back to unset. Chip classes are toggled directly
  // because the panel skips its own rebuild while a chip holds focus.
  const prio = document.createElement("div");
  prio.className = "panel-field";
  const prioLabel = document.createElement("span");
  prioLabel.textContent = "Priority";
  const chips = document.createElement("div");
  chips.className = "prio-chips";
  for (let p = 1; p <= 4; p++) {
    const chip = document.createElement("button");
    chip.className = "prio-chip";
    chip.textContent = `P${p}`;
    if (item.priority === p) chip.classList.add("active");
    chip.addEventListener("click", () => {
      const next = item.priority === p ? null : p;
      for (const c of chips.children) c.classList.remove("active");
      if (next !== null) chip.classList.add("active");
      void actions.updateItem(item.id, { priority: next });
    });
    chips.append(chip);
  }
  // The planning signals — tentative, at-risk, and the flag — ride at the
  // trailing edge of the priority row: item attributes like priority, and
  // three lone toggles do not deserve a row of their own. Kept out of `chips`
  // on purpose — the handler above clears `active` from every child of that
  // container.
  const prioRow = document.createElement("div");
  prioRow.className = "prio-row";
  const signals = document.createElement("div");
  signals.className = "signal-btns";
  signals.append(tentativeButton(item), riskButton(item), flagButton(item));
  prioRow.append(chips, signals);
  prio.append(prioLabel, prioRow);

  const labels = labelsField(item);

  const actionsRow = document.createElement("div");
  actionsRow.className = "panel-actions";
  // "Add Child" only exists for a top-level item (nesting is one level deep),
  // and is the mouse twin of the "c" shortcut: same helper, so both append a child.
  // "Add Sibling" exists for both, and is the mouse twin of the "n" shortcut:
  // same helper, so both land directly after this item.
  if (!parent) {
    const addChild = document.createElement("button");
    addChild.className = "btn";
    addChild.textContent = "Add Child";
    addChild.addEventListener("click", () => void addChildTo(item));
    actionsRow.append(addChild);
  }
  const addSibling = document.createElement("button");
  addSibling.className = "btn";
  addSibling.textContent = "Add Sibling";
  addSibling.addEventListener("click", () => void addSiblingOf(item));
  actionsRow.append(addSibling);
  actionsRow.append(deleteButton("Delete item", () => void confirmAndDeleteItem(item)));

  // The panel reads in two zones, split by a hairline: what this item *is*
  // (title, description, its links) above, how it is *classified* (dates,
  // priority, labels) below. Without the split all six fields competed at the
  // same weight and the title — the reason you opened the panel — read as just
  // another form row. Dependencies join the second zone: how the item relates
  // is classification, not identity.
  const attrs = document.createElement("div");
  attrs.className = "panel-attrs";
  attrs.append(dates.dateRow);
  if (dates.periodRow) attrs.append(dates.periodRow);
  attrs.append(prio, labels, dependenciesSection({ kind: "item", id: item.id }));

  body.append(head, crumb, title.wrap, desc.wrap, linksSection, attrs, actionsRow);
}

// deleteButton is the panel's destructive action for both items and
// milestones: icon-only, so the actions row stays narrow enough for the
// "+ Child"/"+ Sibling" buttons to sit beside it in a 300px panel. Its label
// lives in the tooltip — a trash can needs no other legend.
function deleteButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "icon-btn panel-delete";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.append(icons.trash(16));
  btn.addEventListener("click", onClick);
  return btn;
}

// All three planning signals use the same two-state button. Multi-selection
// adds one display-only state: mixed. Its click still has a binary meaning —
// mixed or false becomes true for all; only uniformly true becomes false.
function metadataSignalButton(
  className: string,
  title: string,
  icon: Node,
  value: boolean | "mixed",
  onChange: (next: boolean) => void,
): HTMLButtonElement {
  let current = value;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `icon-btn ${className}`;
  btn.classList.toggle("active", value === true);
  btn.classList.toggle("mixed", value === "mixed");
  btn.title = value === "mixed" ? `${title} — mixed; click to set for all` : title;
  btn.setAttribute("aria-label", btn.title);
  btn.setAttribute("aria-pressed", String(value));
  btn.append(icon);
  btn.addEventListener("click", () => {
    const next = current !== true;
    current = next;
    btn.classList.remove("mixed");
    btn.classList.toggle("active", next);
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.setAttribute("aria-pressed", String(next));
    onChange(next);
  });
  return btn;
}

// flagButton is the flag's only label anywhere in the UI: an icon-only toggle
// whose tooltip says what the marker means. That is affordable precisely
// because the meaning is the product's and not the user's — there is one flag
// with one meaning, so a glyph plus a tooltip is the whole legend.
function flagButton(item: Item): HTMLButtonElement {
  return metadataSignalButton(
    "flag-btn",
    "Flag: needs attention (!)",
    icons.flag(16),
    item.flagged,
    (flagged) => void actions.setFlagged([item.id], flagged),
  );
}

// tentativeButton and riskButton follow flagButton: icon-only toggles whose
// tooltips are the signals' only labels.
function tentativeButton(item: Item): HTMLButtonElement {
  return metadataSignalButton(
    "tent-btn",
    "Tentative timing: dates are not a precise commitment",
    icons.approx(16),
    item.tentative,
    (tentative) => void actions.updateItem(item.id, { tentative }),
  );
}

function riskButton(item: Item): HTMLButtonElement {
  return metadataSignalButton(
    "risk-btn",
    "At risk: the plan stands, but there is reason to doubt it",
    icons.alertTriangle(16),
    item.atRisk,
    (atRisk) => void actions.updateItem(item.id, { atRisk }),
  );
}

// labelsField is a tag editor: removable chips for the item's labels plus an
// input to add more (Enter/comma commits; a datalist autocompletes existing
// labels). Like the priority chips, it mutates its own DOM on add/remove and
// commits through actions — the panel skips its own rebuild while focused.
function labelsField(item: { id: number; labels: string[] }): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "panel-field";
  const label = document.createElement("span");
  label.textContent = "Labels";

  const editor = document.createElement("div");
  editor.className = "label-editor";
  const chips = document.createElement("div");
  chips.className = "label-chips";
  const input = document.createElement("input");
  input.className = "label-input";
  input.placeholder = "Add label…";
  input.setAttribute("list", "label-suggestions");

  const datalist = document.createElement("datalist");
  datalist.id = "label-suggestions";
  for (const l of state.allLabels()) {
    const opt = document.createElement("option");
    opt.value = l;
    datalist.append(opt);
  }

  let labels = [...item.labels];
  const commit = () => void actions.updateItem(item.id, { labels: [...labels] });

  const renderChips = () => {
    chips.replaceChildren();
    for (const l of labels) {
      const chip = document.createElement("span");
      chip.className = "label-chip";
      const text = document.createElement("span");
      text.textContent = l;
      const x = document.createElement("button");
      x.className = "label-x";
      x.title = "Remove";
      x.append(icons.x(12));
      x.addEventListener("click", () => {
        labels = labels.filter((v) => v !== l);
        renderChips();
        commit();
      });
      chip.append(text, x);
      chips.append(chip);
    }
  };

  const add = () => {
    const v = input.value.trim();
    input.value = "";
    if (!v || labels.includes(v)) return;
    labels.push(v);
    renderChips();
    commit();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && input.value === "" && labels.length > 0) {
      labels.pop();
      renderChips();
      commit();
    }
  });
  input.addEventListener("blur", add); // commit a typed-but-unentered label

  renderChips();
  editor.append(chips, input, datalist);
  wrap.append(label, editor);
  return wrap;
}

function renderMilestonePanel(body: HTMLElement, loc: MilestoneLocation): void {
  const { milestone, lane } = loc;
  const key = `ms:${milestone.id}`;
  // Don't rebuild under the user's cursor while they are typing.
  if (renderedKey === key && body.contains(document.activeElement)) {
    return;
  }
  renderedKey = key;
  body.replaceChildren();
  body.style.setProperty("--c", laneColorValue(lane.color));

  const head = railHead(
    "Milestone",
    depsGraphButton({ kind: "milestone", id: milestone.id }),
    copyLinkButton("milestone", milestone.id),
    closeButton(),
  );

  const crumb = crumbLine(lane.name);

  const title = titleField(milestone.title);
  // Same hook as the item panel: only one panel renders at a time, so the id
  // stays unique and focusPanelTitle serves both.
  title.control.id = PANEL_TITLE_ID;
  title.control.addEventListener("change", () => {
    const v = title.control.value.trim();
    if (v && v !== milestone.title) void actions.updateMilestone(milestone.id, { title: v });
  });

  const dates = milestoneDateEditor(milestone);

  const desc = field("Description", "textarea");
  (desc.control as HTMLTextAreaElement).value = milestone.description;
  desc.control.addEventListener("change", () => {
    const v = (desc.control as HTMLTextAreaElement).value;
    if (v !== milestone.description) void actions.updateMilestone(milestone.id, { description: v });
  });

  const linksSection = createLinksSection(desc.control as HTMLTextAreaElement);

  const actionsRow = document.createElement("div");
  actionsRow.className = "panel-actions";
  actionsRow.append(
    deleteButton("Delete milestone", () => void confirmAndDeleteMilestone(milestone)),
  );

  // Same two zones as the item panel, which puts the date below the
  // description rather than above it: an item's start/end sit there too, and
  // the panels reading alike matters more than a milestone's date being its
  // most important attribute.
  const attrs = document.createElement("div");
  attrs.className = "panel-attrs";
  attrs.append(dates.dateRow);
  if (dates.periodRow) attrs.append(dates.periodRow);
  attrs.append(dependenciesSection({ kind: "milestone", id: milestone.id }));

  body.append(head, crumb, title.wrap, desc.wrap, linksSection, attrs, actionsRow);
}

function field(
  label: string,
  tag: "input" | "textarea",
): { wrap: HTMLElement; control: HTMLInputElement | HTMLTextAreaElement } {
  const wrap = document.createElement("label");
  wrap.className = "panel-field";
  const span = document.createElement("span");
  span.textContent = label;
  const control = document.createElement(tag) as HTMLInputElement | HTMLTextAreaElement;
  wrap.append(span, control);
  return { wrap, control };
}

// periodSelect is a second way to set the date field above it, for people who
// plan in "PI2027-09" rather than in the day it starts on. The panel twin of
// the "schedule" snap grid (dnd.ts): it writes a plain date, and the date stays
// the model. No visible label — it sets the field it sits under, which is what
// the aria-label carries for anyone who can't see that.
//
// "—" is the state of a date that isn't on any period edge. Disabled, because
// it reports rather than offers: "no period" is not a date you can set.
function periodSelect(
  ariaLabel: string,
  periods: SchedulePeriod[],
  onPick: (p: SchedulePeriod) => void,
): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "panel-select";
  sel.setAttribute("aria-label", ariaLabel);
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "—";
  // A dash announces as "dash". Every other option says what it is out loud, so
  // this one gets a label that does too — the dash is a compact way of drawing
  // "no period", not the meaning itself.
  none.setAttribute("aria-label", "No period");
  none.disabled = true;
  sel.append(none);
  for (const p of periods) {
    const opt = document.createElement("option");
    opt.value = String(p.id);
    opt.textContent = p.label;
    sel.append(opt);
  }
  sel.addEventListener("change", () => {
    const picked = periods.find((p) => String(p.id) === sel.value);
    if (picked) onPick(picked);
  });
  return sel;
}

function periodRow(...selects: HTMLSelectElement[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "panel-row panel-row-sub";
  row.append(...selects);
  return row;
}

// titleField is the panel's heading rather than another labelled row: the name
// is what you opened the panel to read, so it earns typographic weight instead
// of sitting at the same size as the date picker. It carries no visible label
// — the kind chip above it already reads "Item"/"Milestone" — so the name is
// exposed to assistive tech via aria-label, and the placeholder keeps an
// untitled item from rendering as blank space.
//
// It is also the field every create path drops the cursor into, so it is where
// a run of "n, type, n, type" either flows or stalls. Enter steps out of it,
// which is the whole trick: bare-letter shortcuts are suppressed while a text
// field has focus (keys.ts), so without a way out "n" would just type an "n".
// Stepping out keeps the item selected, so "n" and "c" still have a target.
// Esc follows the same rule globally and works for every panel field.
//
// Blurring is the save: Enter has already fired `change` natively and the
// field's own commit handler did the writing, so there is no second save path
// here — exactly as in flushPendingEdit.
function titleField(value: string): { wrap: HTMLElement; control: HTMLInputElement } {
  const wrap = document.createElement("label");
  wrap.className = "panel-field panel-title-field";
  const control = document.createElement("input");
  control.className = "panel-title-input";
  control.value = value;
  control.placeholder = "Untitled";
  control.setAttribute("aria-label", "Title");
  control.addEventListener("keydown", (e) => {
    if (e.key === "Enter") control.blur();
  });
  wrap.append(control);
  return { wrap, control };
}

// crumbLine builds the breadcrumb under the kind chip, led by a dot in the
// lane's color (the panel already carries --c for the priority chips). Lane
// color is the app's only color language, so this ties the panel to the lane
// it is editing without inventing a second one.
function crumbLine(text: string): HTMLElement {
  const crumb = document.createElement("div");
  crumb.className = "panel-crumb";
  const dot = document.createElement("span");
  dot.className = "crumb-dot";
  const label = document.createElement("span");
  label.className = "crumb-text";
  label.textContent = text;
  crumb.append(dot, label);
  return crumb;
}

// Render links from the live textarea so chips track uncommitted edits.
function createLinksSection(descControl: HTMLTextAreaElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "links-section";

  const render = () => {
    wrap.replaceChildren();
    const links = extractLinks(descControl.value);
    wrap.style.display = links.length === 0 ? "none" : "block";
    if (links.length === 0) return;

    const label = document.createElement("span");
    label.className = "panel-field-label";
    label.textContent = "External links";
    label.title = "Write [text](url) in the description to name a link";

    const chips = document.createElement("div");
    chips.className = "links-chips";
    for (const link of links) {
      const chip = document.createElement("a");
      chip.className = "link-chip";
      chip.href = link.url;
      chip.target = "_blank";
      chip.rel = "noopener noreferrer";
      chip.textContent = link.label;
      chip.title = link.url;
      chips.append(chip);
    }
    wrap.append(label, chips);
  };

  render();
  descControl.addEventListener("input", render);
  return wrap;
}
