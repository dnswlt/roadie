// The edit side-panel for the selected item. Values are committed on
// change (blur / Enter / date pick); structural actions (add child,
// delete) go through actions.ts.

import { actions } from "./actions";
import { laneColorValue } from "./colors";
import { confirmDialog } from "./dialogs";
import { icons } from "./icons";
import { extractUrls, linkLabel } from "./links";
import { state, type MilestoneLocation } from "./state";
import { toast } from "./toast";
import type { Item, ItemFull, Milestone } from "./types";
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
  btn.addEventListener("click", async () => {
    const roadmap = state.current;
    if (!roadmap) return;
    try {
      await navigator.clipboard.writeText(selectionLink(roadmap, kind, id));
      toast("Link copied");
    } catch {
      toast("Couldn't copy link", true);
    }
  });
  return btn;
}

// Identifies what the panel currently shows, e.g. "item:5" or "ms:3", so a
// re-render can skip rebuilding the panel under the user's cursor.
let renderedKey: string | null = null;

// The panel element, captured on render so flushPendingEdit can find it.
let panelEl: HTMLElement | null = null;

// flushPendingEdit commits whatever panel field the user is still typing in.
// Fields save on `change`, which fires only on blur — but Esc and the Close
// button tear the panel down while the field still has focus, and an element
// removed from the DOM fires neither blur nor change, silently dropping the
// edit. Blurring here fires `change` synchronously, so the field's own commit
// handler does the saving and no second save path exists.
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

// renderSelectionPanel: several items selected. The fields are all per-item, so
// there is nothing to edit here — but Delete is already defined for many (the
// Del shortcut has always handled it, see deleteSelection), and showing the
// count turns a panel that used to vanish into one that explains itself.
function renderSelectionPanel(body: HTMLElement): void {
  const n = state.selectedItemIds.size;
  // Keyed on the count alone: the view shows nothing else about *which* items
  // are selected, and Delete reads the live selection when clicked.
  const key = `multi:${n}`;
  if (renderedKey === key) return;
  renderedKey = key;
  body.replaceChildren();
  body.style.removeProperty("--c");

  const note = noteBlock(`${n} items selected`, "Select a single item to edit its fields.");

  const actionsRow = document.createElement("div");
  actionsRow.className = "panel-actions";
  actionsRow.append(deleteButton(`Delete ${n} items`, () => deleteSelection()));

  body.append(railHead("Selection", closeButton()), note, actionsRow);
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

  const dates = document.createElement("div");
  dates.className = "panel-row";
  const start = field("Start", "input");
  (start.control as HTMLInputElement).type = "date";
  (start.control as HTMLInputElement).value = item.startDate;
  const end = field("End", "input");
  (end.control as HTMLInputElement).type = "date";
  (end.control as HTMLInputElement).value = item.endDate;
  start.control.addEventListener("change", () => {
    const v = (start.control as HTMLInputElement).value;
    if (v && v !== item.startDate) void actions.updateItem(item.id, { startDate: v });
  });
  end.control.addEventListener("change", () => {
    const v = (end.control as HTMLInputElement).value;
    if (v && v !== item.endDate) void actions.updateItem(item.id, { endDate: v });
  });
  dates.append(start.wrap, end.wrap);

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
    chip.className = `prio-chip p${p}`;
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
  // The flag rides at the trailing edge of the priority row: it is an item
  // attribute like priority, and a lone toggle does not deserve its own row.
  // Kept out of `chips` on purpose — the handler above clears `active` from
  // every child of that container.
  const prioRow = document.createElement("div");
  prioRow.className = "prio-row";
  prioRow.append(chips, flagButton(item));
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
  // another form row.
  const attrs = document.createElement("div");
  attrs.className = "panel-attrs";
  attrs.append(dates, prio, labels);

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

// flagButton is the flag's only label anywhere in the UI: an icon-only toggle
// whose tooltip says what the marker means. That is affordable precisely
// because the meaning is the product's and not the user's — there is one flag
// with one meaning, so a glyph plus a tooltip is the whole legend.
function flagButton(item: Item): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = item.flagged ? "icon-btn flag-btn active" : "icon-btn flag-btn";
  btn.title = "Flag: needs attention (!)";
  btn.append(icons.flag(16));
  btn.addEventListener("click", () => {
    // Toggled directly, like the priority chips: the panel skips its own
    // rebuild while a control holds focus, so the class has to move by hand.
    btn.classList.toggle("active");
    void actions.setFlagged([item.id], !item.flagged);
  });
  return btn;
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

  const head = railHead("Milestone", copyLinkButton("milestone", milestone.id), closeButton());

  const crumb = crumbLine(lane.name);

  const title = titleField(milestone.title);
  // Same hook as the item panel: only one panel renders at a time, so the id
  // stays unique and focusPanelTitle serves both.
  title.control.id = PANEL_TITLE_ID;
  title.control.addEventListener("change", () => {
    const v = title.control.value.trim();
    if (v && v !== milestone.title) void actions.updateMilestone(milestone.id, { title: v });
  });

  const dateField = field("Date", "input");
  (dateField.control as HTMLInputElement).type = "date";
  (dateField.control as HTMLInputElement).value = milestone.date;
  dateField.control.addEventListener("change", () => {
    const v = (dateField.control as HTMLInputElement).value;
    if (v && v !== milestone.date) void actions.updateMilestone(milestone.id, { date: v });
  });

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
  attrs.append(dateField.wrap);

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

// titleField is the panel's heading rather than another labelled row: the name
// is what you opened the panel to read, so it earns typographic weight instead
// of sitting at the same size as the date picker. It carries no visible label
// — the kind chip above it already reads "Item"/"Milestone" — so the name is
// exposed to assistive tech via aria-label, and the placeholder keeps an
// untitled item from rendering as blank space.
function titleField(value: string): { wrap: HTMLElement; control: HTMLInputElement } {
  const wrap = document.createElement("label");
  wrap.className = "panel-field panel-title-field";
  const control = document.createElement("input");
  control.className = "panel-title-input";
  control.value = value;
  control.placeholder = "Untitled";
  control.setAttribute("aria-label", "Title");
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

// createLinksSection shows the URLs found in a description as clickable chips.
// It reads the live textarea and re-renders on input, so links track edits
// before they are committed.
function createLinksSection(descControl: HTMLTextAreaElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "links-section";

  const render = () => {
    wrap.replaceChildren();
    const urls = extractUrls(descControl.value);
    wrap.style.display = urls.length === 0 ? "none" : "block";
    if (urls.length === 0) return;

    const label = document.createElement("span");
    label.className = "panel-field-label";
    label.textContent = "External links";

    const chips = document.createElement("div");
    chips.className = "links-chips";
    for (const url of urls) {
      const chip = document.createElement("a");
      chip.className = "link-chip";
      chip.href = url;
      chip.target = "_blank";
      chip.rel = "noopener noreferrer";
      chip.textContent = linkLabel(url);
      chip.title = url;
      chips.append(chip);
    }
    wrap.append(label, chips);
  };

  render();
  descControl.addEventListener("input", render);
  return wrap;
}
