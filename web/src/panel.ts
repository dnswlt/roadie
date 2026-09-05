// The edit side-panel for the selected item. Text values are committed when
// editing finishes (blur / Enter); deliberate picks and structural actions
// (add child, delete) commit immediately through actions.ts.

import { actions } from "./actions";
import { api } from "./api";
import { copyText } from "./clipboard";
import { laneColorValue } from "./colors";
import { editRangeDate, parseDateInput, type DateEdge } from "./dates";
import { dependenciesSection, depsGraphButton } from "./deps";
import { confirmDialog } from "./dialogs";
import { icons } from "./icons";
import { parseLabelInput } from "./labels";
import { extractLinks } from "./links";
import { itemMarkdown } from "./markdown";
import { periodAtEdge, periodDates, periodsByStart } from "./schedule";
import { state, type MilestoneLocation } from "./state";
import type { Item, ItemFull, LaneFull, Milestone, SchedulePeriod } from "./types";
import { writeParams } from "./url";

const PANEL_TITLE_ID = "panel-item-title";
const CONSUMER_PREVIEW_LIMIT = 5;

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
  const usedBy = milestone.linkage?.integration
    ? await freshIntegrationUsage(milestone)
    : 0;
  const usage = integrationUsageCopy(usedBy);
  const content = usage
    ? {
        title: usage.title,
        message: `Delete milestone "${milestone.title}"? ${usage.consequence}`,
      }
    : `Delete milestone "${milestone.title}"?`;
  if (await confirmDialog(content)) {
    void actions.deleteMilestone(milestone.id);
  }
}

function integrationUsageCopy(usedBy: number): { title: string; consequence: string } | null {
  if (usedBy === 0) return null;
  if (usedBy === 1) {
    return {
      title: "One other roadmap depends on this milestone",
      consequence: "Its linked milestone and dependencies will remain, but updates will stop.",
    };
  }
  return {
    title: `${usedBy} other roadmaps depend on this milestone`,
    consequence: "Their linked milestones and dependencies will remain, but updates will stop.",
  };
}

// Cross-roadmap usage is derived on reads, and consumer mutations do not ring
// the provider roadmap's SSE doorbell. Refresh it at the destructive decision
// point rather than trusting the count from when this roadmap was opened.
async function freshIntegrationUsage(milestone: Milestone): Promise<number> {
  const fallback = milestone.linkage?.usedBy ?? 0;
  const roadmapId = state.current?.id;
  if (!roadmapId) return fallback;
  try {
    const full = await api.getRoadmap(roadmapId);
    for (const lane of full.lanes) {
      const current = lane.milestones.find((candidate) => candidate.id === milestone.id);
      if (current) return current.linkage?.usedBy ?? 0;
    }
  } catch {
    // Confirmation remains available offline or through a transient read
    // failure; the loaded count is still more useful than hiding the impact.
  }
  return fallback;
}

async function confirmIntegrationDateChange(
  milestone: Milestone,
  previous: string,
  next: string,
): Promise<boolean> {
  const usedBy = await freshIntegrationUsage(milestone);
  const usage = integrationUsageCopy(usedBy);
  const content = usage
    ? {
        title: usage.title,
        message: `Change the date of "${milestone.title}" from ${previous} to ${next}? ${
          usedBy === 1 ? "Its linked milestone" : "Their linked milestones"
        } will move to the new date.`,
      }
    : {
        title: "Change integration milestone date?",
        message: `Change the date of "${milestone.title}" from ${previous} to ${next}? Other roadmaps may be planning against the published date.`,
      };
  return confirmDialog(content, "Change date", "primary");
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

// toggleFlagSelection flags or unflags the selected milestone or every selected
// item, behind the panel chip and the "!" shortcut. Item multi-selection flags
// on a mixed state and clears only when everything is already flagged.
export function toggleFlagSelection(): void {
  if (state.preview) return;
  if (state.selectedMilestoneId !== null) {
    const milestone = state.findMilestone(state.selectedMilestoneId)?.milestone;
    if (milestone) void actions.updateMilestone(milestone.id, { flagged: !milestone.flagged });
    return;
  }
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

// copyLinkButton copies the address bar, which already names this selection
// (see url.ts) — it builds no link of its own. It exists because the location
// bar is easy to overlook, not because it knows something the URL doesn't.
function copyLinkButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "icon-btn";
  btn.title = "Copy link to this selection";
  btn.append(icons.link(16));
  btn.addEventListener("click", () => void copyText(window.location.href, "Link"));
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

// Panel saves notify synchronously, before focus has finished moving. Keep the
// current controls for that render so Tab can reach its intended destination.
let savingPanelField = false;

function savePanelField(save: () => void): void {
  savingPanelField = true;
  try {
    save();
  } finally {
    savingPanelField = false;
  }
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
//
// Returns whether an edit was actually pending — a text control, not a button
// or a select, both of which have already committed. Escape reads that to know
// whether it means "finish this edit" or something view-level.
export function flushPendingEdit(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !panelEl?.contains(el)) return false;
  const pending = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  el.blur();
  return pending;
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
  // With mixed priorities no chip is active, which otherwise looks exactly
  // like every selected item being unprioritized. Keep that distinction in
  // the section label; planning-signal buttons carry their own mixed state.
  const metadata = metadataField(
    [
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
    ],
    chips,
    priority.mixed ? "Metadata · Mixed priority" : "Metadata",
  );

  const attrs = document.createElement("div");
  attrs.className = "panel-attrs multi-meta";
  attrs.append(metadata);

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

interface DateField {
  wrap: HTMLElement;
  show: (value: string) => void;
  disable: (title: string) => void;
}

// A native date input conflates editing a segment with committing the date:
// Chromium fires `change` while the cursor is still in the field. Keep the
// useful half of that control — its calendar — but give keyboard editing to an
// ordinary ISO text field with ordinary text-field semantics. The two distinct
// controls make commit intent explicit rather than inferred from pointer or
// keyboard events.
function dateField(
  label: string,
  pickerTitle: string,
  edge: DateEdge,
  onCommit: (value: string) => void,
): DateField {
  const wrap = document.createElement("div");
  wrap.className = "panel-field";
  const caption = document.createElement("span");
  caption.textContent = label;

  const editor = document.createElement("div");
  editor.className = "panel-date-editor";
  const input = document.createElement("input");
  input.className = "panel-date-input";
  input.type = "text";
  input.placeholder = "YYYY-MM-DD";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", label);

  const open = document.createElement("button");
  open.type = "button";
  open.className = "icon-btn panel-date-picker";
  open.title = pickerTitle;
  open.setAttribute("aria-label", open.title);
  open.append(icons.calendar(15));

  // Kept rendered so showPicker() can anchor the browser calendar beside the
  // button. It never receives ordinary focus: keyboard users open it through
  // the labelled button, just like mouse users.
  const picker = document.createElement("input");
  picker.className = "panel-native-date-picker";
  picker.type = "date";
  picker.tabIndex = -1;
  picker.setAttribute("aria-hidden", "true");

  const error = document.createElement("span");
  error.className = "panel-field-error";
  error.textContent = "Try 2026-07-15, 7/26, or Q3/2026";
  error.hidden = true;

  let committed = "";
  const clearError = (): void => {
    input.removeAttribute("aria-invalid");
    error.hidden = true;
  };
  const show = (value: string): void => {
    committed = value;
    input.value = value;
    picker.value = value;
    clearError();
  };
  const commitText = (): void => {
    const next = parseDateInput(input.value, edge);
    if (next === null) {
      input.setAttribute("aria-invalid", "true");
      error.hidden = false;
      return;
    }
    clearError();
    onCommit(next);
  };

  input.addEventListener("input", clearError);
  input.addEventListener("blur", commitText);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
  });
  open.addEventListener("click", () => {
    const draft = parseDateInput(input.value, edge);
    // An unusable draft is abandoned before the calendar opens. It would
    // otherwise start on the committed date, and choosing that same day fires
    // no change event — leaving the field marked invalid and the pick ignored.
    if (draft !== null) picker.value = draft;
    else show(committed);
    // No feature detection: where showPicker is missing the button is inert and
    // the text field is the whole editor, which is the deal.
    picker.showPicker();
  });
  picker.addEventListener("change", () => {
    if (picker.value) onCommit(picker.value);
  });

  editor.append(input, open, picker);
  wrap.append(caption, editor, error);
  return {
    wrap,
    show,
    disable(title: string): void {
      input.disabled = true;
      input.title = title;
      open.disabled = true;
      open.title = title;
      open.setAttribute("aria-label", title);
      picker.disabled = true;
      wrap.title = title;
    },
  };
}

// itemDateEditor owns every control that edits one date range: the two date
// fields and, when the roadmap has a schedule, the two period selects beneath
// them. `value` is their one shared state. Every edit passes through show
// (synchronize all controls) and commit (send one minimal patch), so neither
// the DOM nor the item captured by render has to masquerade as the latest value
// while the focused panel deliberately skips rebuilds.
function itemDateEditor(item: Item): DateEditorRows {
  const dates = document.createElement("div");
  dates.className = "panel-row";
  const start = dateField("Start", "Choose start date", "start", (date) => edit("start", date));
  const end = dateField("End", "Choose end date", "end", (date) => edit("end", date));
  dates.append(start.wrap, end.wrap);

  const periods = periodsByStart(state.current?.periods ?? []);
  let value: ItemDates = { startDate: item.startDate, endDate: item.endDate };
  let startPeriod: HTMLSelectElement | null = null;
  let endPeriod: HTMLSelectElement | null = null;

  const show = (next: ItemDates): void => {
    value = next;
    start.show(next.startDate);
    end.show(next.endDate);
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
    if (patch.startDate || patch.endDate) {
      savePanelField(() => void actions.updateItem(item.id, patch));
    }
  };
  function edit(edge: "start" | "end", date: string): void {
    commit(editRangeDate(edge, date, value));
  }

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
// value drives both the date field and its optional "Due in" period select.
function milestoneDateEditor(milestone: Milestone): DateEditorRows {
  const periods = periodsByStart(state.current?.periods ?? []);
  let value = milestone.date;
  let duePeriod: HTMLSelectElement | null = null;

  const show = (next: string): void => {
    value = next;
    date.show(next);
    if (duePeriod) {
      duePeriod.value = periodAtEdge(periods, "end", next)?.id.toString() ?? "";
    }
  };
  const commit = (next: string): void => {
    const previous = value;
    show(next);
    if (next === previous) return;
    void (async () => {
      if (
        milestone.linkage?.integration &&
        !(await confirmIntegrationDateChange(milestone, previous, next))
      ) {
        show(previous);
        return;
      }
      savePanelField(() => void actions.updateMilestone(milestone.id, { date: next }));
    })();
  };
  const date = dateField("Date", "Choose date", "end", commit);
  const sourceOwned = milestone.linkage?.sourceUid !== undefined;
  const sourceOwnedTitle = "This date is planned by the source roadmap";
  if (sourceOwned) date.disable(sourceOwnedTitle);

  let periodRowElement: HTMLElement | null = null;
  if (periods.length > 0) {
    // A milestone due in a period lands on its last day: it is a deadline, not
    // work spanning that period.
    duePeriod = periodSelect("Due in period", periods, (p) => commit(p.endDate));
    if (sourceOwned) {
      duePeriod.disabled = true;
      duePeriod.title = sourceOwnedTitle;
    }
    periodRowElement = periodRow(duePeriod);
  }
  show(value);
  return { dateRow: date.wrap, periodRow: periodRowElement };
}

// Hidden contexts stay in the list — a context you can't see is still a place a
// selected entity belongs. Moving into one takes it off the chart, and the
// selection follows it out, exactly as hiding its own context would. The
// current lane is read lazily because optimistic actions mutate the entity
// while the focused select remains mounted.
function laneSelect(
  currentLaneId: () => number,
  onChange: (laneId: number, select: HTMLSelectElement) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "panel-field";
  const caption = document.createElement("span");
  caption.textContent = "Context";

  const sel = document.createElement("select");
  sel.className = "panel-select";
  sel.setAttribute("aria-label", "Context");
  for (const l of state.current?.lanes ?? []) {
    const opt = document.createElement("option");
    opt.value = String(l.id);
    opt.textContent = l.name;
    sel.append(opt);
  }
  sel.value = String(currentLaneId());
  sel.addEventListener("change", () => {
    const laneId = Number(sel.value);
    if (laneId !== currentLaneId()) onChange(laneId, sel);
  });

  wrap.append(caption, sel);
  return wrap;
}

// milestoneLaneSelect moves a milestone between contexts. It is the only way
// to do that: a milestone is a point with no width, so a timeline drag would
// mean date and context at once with no separate grab region to tell them
// apart (see dnd.ts, which treats a milestone as "not a bar").
//
// A mirror's context belongs to the consuming roadmap, which picked it when the
// mirror was created, so this is enabled where the date and tentative fields
// are not.
function milestoneLaneSelect(milestone: Milestone): HTMLElement {
  return laneSelect(
    () => milestone.laneId,
    (laneId) => {
      savePanelField(() => void actions.updateMilestone(milestone.id, { laneId }));
    },
  );
}

// Moving a child to another context also detaches it: a child inherits its
// parent's context, so keeping the parent would make the requested move
// impossible. That structural change rebuilds the panel immediately so its
// header and child actions describe the item's new top-level position.
function itemLaneSelect(item: Item): HTMLElement {
  return laneSelect(
    () => item.laneId,
    (laneId, select) => {
      if (item.parentId !== null) {
        // The focused-field guard normally preserves the rail. A detach changes
        // the form itself, so release focus and let updateItem rebuild it.
        select.blur();
        void actions.updateItem(item.id, { laneId, parentId: null });
        return;
      }
      savePanelField(() => void actions.updateItem(item.id, { laneId }));
    },
  );
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

  // Don't rebuild under the user's cursor while they are typing, and don't
  // rebuild out from under a commit that is handing focus to the next field.
  const key = `item:${loc.item.id}`;
  if (renderedKey === key && (savingPanelField || panel.contains(document.activeElement))) {
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
    copyLinkButton(),
    closeButton(),
  );

  const crumb = crumbLine(parent ? `${lane.name} › ${parent.title}` : lane.name);

  const title = titleField(item.title);
  // Stable hook for focusPanelTitle — the panel has several .panel-field
  // inputs, so the Title one needs to be addressable by more than position.
  title.control.id = PANEL_TITLE_ID;
  title.control.addEventListener("change", () => {
    const v = title.control.value.trim();
    if (v && v !== item.title) {
      savePanelField(() => void actions.updateItem(item.id, { title: v }));
    }
  });

  const desc = field("Description", "textarea");
  (desc.control as HTMLTextAreaElement).value = item.description;
  desc.control.addEventListener("change", () => {
    const v = (desc.control as HTMLTextAreaElement).value;
    if (v !== item.description) {
      savePanelField(() => void actions.updateItem(item.id, { description: v }));
    }
  });

  const linksSection = createLinksSection(desc.control as HTMLTextAreaElement);

  const dates = itemDateEditor(item);

  // Four priority chips (P1 highest .. P4 lowest) trail the planning signals
  // in Metadata. Clicking the active chip clears priority back to unset. Chip
  // classes toggle directly because the panel skips rebuilding while focused.
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
  // The planning signals — tentative, at-risk, and the flag — lead the
  // metadata row; priority is the less important classification and trails.
  // They stay out of `chips` because the handler above clears `active` from
  // every child of that container.
  const metadata = metadataField(
    [tentativeButton(item), riskButton(item), flagButton(item)],
    chips,
  );

  const labels = labelsField(item.labels, (labels) =>
    void actions.updateItem(item.id, { labels }),
  );

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
  attrs.append(
    metadata,
    labels,
    dependenciesSection({ kind: "item", id: item.id }),
    // Last, above the item actions, matching the milestone panel: most items
    // land in the right context when created and move only occasionally.
    itemLaneSelect(item),
  );

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

// Planning signals use the same two-state button. Multi-selection adds one
// display-only state: mixed. Its click still has a binary meaning — mixed or
// false becomes true for all; only uniformly true becomes false.
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

// metadataField is the shared panel scaffold for planning-signal buttons and,
// for items, the trailing priority picker. Milestones use the same structure,
// so their signals keep the same alignment and spacing.
function metadataField(
  signals: HTMLButtonElement[],
  chips?: HTMLElement,
  label = "Metadata",
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "panel-field";
  const heading = document.createElement("span");
  heading.textContent = label;
  const row = document.createElement("div");
  row.className = "metadata-row";
  const signalGroup = document.createElement("div");
  signalGroup.className = "signal-btns";
  signalGroup.append(...signals);
  row.append(signalGroup);
  if (chips) row.append(chips);
  wrap.append(heading, row);
  return wrap;
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

function milestoneTentativeButton(milestone: Milestone): HTMLButtonElement {
  return metadataSignalButton(
    "tent-btn",
    "Tentative timing: date is not a precise commitment",
    icons.approx(16),
    milestone.tentative,
    (tentative) => void actions.updateMilestone(milestone.id, { tentative }),
  );
}

function milestoneRiskButton(milestone: Milestone): HTMLButtonElement {
  return metadataSignalButton(
    "risk-btn",
    "At risk: the milestone date stands, but there is reason to doubt it",
    icons.alertTriangle(16),
    milestone.atRisk,
    (atRisk) => void actions.updateMilestone(milestone.id, { atRisk }),
  );
}

function milestoneFlagButton(milestone: Milestone): HTMLButtonElement {
  return metadataSignalButton(
    "flag-btn",
    "Flag: needs attention (!)",
    icons.flag(16),
    milestone.flagged,
    (flagged) => void actions.updateMilestone(milestone.id, { flagged }),
  );
}

function milestoneIntegrationButton(milestone: Milestone): HTMLButtonElement {
  const published = milestone.linkage?.integration ?? false;
  const title = "Integration milestone: other roadmaps may depend on it";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn integration-btn";
  button.classList.toggle("active", published);
  button.title = title;
  button.setAttribute("aria-label", title);
  button.setAttribute("aria-pressed", String(published));
  button.append(icons.providedInterface(16));
  // Publishing creates a cross-roadmap contract, whose two ends must remain
  // visible to each other. A private provider may still unpublish one left
  // behind by a visibility change.
  if (!published && state.current?.visibility !== "public") {
    button.disabled = true;
    button.title = "Make this roadmap public before publishing an integration milestone";
    button.setAttribute("aria-label", button.title);
    return button;
  }

  button.addEventListener("click", () => {
    button.disabled = true;
    void (async () => {
      const next = !published;
      let confirmed: boolean;
      if (next) {
        confirmed = await confirmDialog(
          `Make "${milestone.title}" an integration milestone? Other roadmaps will be able to link to it and plan against it. Treat this as a contract they may rely on.`,
          "Make integration milestone",
          "primary",
        );
      } else {
        const usedBy = await freshIntegrationUsage(milestone);
        const usage = integrationUsageCopy(usedBy);
        const content = usage
          ? {
              title: usage.title,
              message: `Remove integration status from "${milestone.title}"? ${usage.consequence}`,
            }
          : `Remove integration status from "${milestone.title}"? Other roadmaps will no longer be able to link it.`;
        confirmed = await confirmDialog(
          content,
          "Remove integration status",
          "danger",
        );
      }
      if (!confirmed) {
        button.disabled = false;
        return;
      }
      button.classList.toggle("active", next);
      button.setAttribute("aria-pressed", String(next));
      button.blur();
      await actions.updateMilestone(milestone.id, { integration: next });
    })();
  });
  return button;
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

// labelsField is a tag editor: removable chips for an entity's labels plus an
// input to add more (Enter/comma commits; a datalist autocompletes existing
// labels). Like the priority chips, it mutates its own DOM on add/remove and
// commits through actions — the panel skips its own rebuild while focused.
function labelsField(
  initialLabels: readonly string[],
  update: (labels: string[]) => void,
): HTMLElement {
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
  input.setAttribute("aria-label", "Add label");
  input.setAttribute("list", "label-suggestions");

  const error = document.createElement("span");
  error.id = "label-input-error";
  error.className = "panel-field-error";
  error.setAttribute("aria-live", "polite");
  error.hidden = true;
  input.setAttribute("aria-describedby", error.id);
  const clearError = () => {
    input.removeAttribute("aria-invalid");
    error.hidden = true;
    error.textContent = "";
  };

  const datalist = document.createElement("datalist");
  datalist.id = "label-suggestions";
  for (const l of state.allLabels()) {
    const opt = document.createElement("option");
    opt.value = l;
    datalist.append(opt);
  }

  let labels = [...initialLabels];
  const commit = () => savePanelField(() => update([...labels]));

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
    const result = parseLabelInput(input.value);
    if ("error" in result) {
      input.setAttribute("aria-invalid", "true");
      error.hidden = false;
      error.textContent = result.error;
      return;
    }
    clearError();
    const v = result.value;
    input.value = "";
    if (!v || labels.includes(v)) return;
    labels.push(v);
    renderChips();
    commit();
  };

  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && input.value === "" && labels.length > 0) {
      labels.pop();
      renderChips();
      commit();
    }
  });
  input.addEventListener("input", clearError);
  input.addEventListener("blur", add); // commit a typed-but-unentered label

  renderChips();
  editor.append(chips, input, datalist);
  wrap.append(label, editor, error);
  return wrap;
}

function crossRoadmapMilestoneLink(
  roadmapId: number,
  roadmapName: string,
  milestoneId: number,
  title: string,
  icon: SVGSVGElement,
): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "dep-go cross-roadmap-link";
  const url = new URL(window.location.href);
  writeParams(url.searchParams, {
    roadmap: { id: roadmapId, name: roadmapName },
    view: state.navigation.view === "wbs" ? "wbs" : "timeline",
    tab: null,
    selection: { kind: "milestone", id: milestoneId },
  });
  url.hash = "";
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = `Open ${title} in ${roadmapName} in a new tab`;
  link.append(icon);
  const text = document.createElement("span");
  text.className = "cross-roadmap-text";
  const milestoneTitle = document.createElement("span");
  milestoneTitle.className = "dep-go-title";
  milestoneTitle.textContent = title;
  const roadmap = document.createElement("span");
  roadmap.className = "cross-roadmap-roadmap";
  roadmap.textContent = roadmapName;
  text.append(milestoneTitle, roadmap);
  link.append(text);
  return link;
}

function mirrorSourceGroup(milestone: Milestone): HTMLElement | undefined {
  const linkage = milestone.linkage;
  if (!linkage?.sourceUid) return undefined;

  const group = document.createElement("div");
  group.className = "dep-group";
  const head = document.createElement("div");
  head.className = "dep-group-head";
  const label = document.createElement("span");
  label.className = "dep-group-label";
  label.textContent = "Source milestone";
  head.append(label);

  const row = document.createElement("div");
  row.className = "dep-row";
  const source = linkage.source;
  if (source?.roadmapId && source.milestoneId) {
    row.append(
      crossRoadmapMilestoneLink(
        source.roadmapId,
        source.roadmapName ?? "External roadmap",
        source.milestoneId,
        source.title ?? "Source milestone",
        icons.providedInterface(14),
      ),
    );
  } else {
    row.title =
      "The source milestone was deleted, made private, or is no longer an integration milestone";
    const warning = document.createElement("span");
    warning.className = "warning-chip";
    warning.append(icons.requiredInterface(14));
    const unavailable = document.createElement("button");
    unavailable.type = "button";
    unavailable.disabled = true;
    unavailable.className = "dep-go mirror-source-unavailable";
    const title = document.createElement("span");
    title.className = "dep-go-title";
    title.textContent = "Source unavailable";
    unavailable.append(title);
    row.append(warning, unavailable);
  }
  group.append(head, row);
  return group;
}

function integrationConsumersGroup(milestone: Milestone): HTMLElement | undefined {
  const consumers = milestone.linkage?.integration
    ? milestone.linkage.consumers ?? []
    : [];
  if (consumers.length === 0) return undefined;

  const group = document.createElement("div");
  group.className = "dep-group";
  const head = document.createElement("div");
  head.className = "dep-group-head";
  const label = document.createElement("span");
  label.className = "dep-group-label";
  label.textContent = "Used by";
  head.append(label);

  const rows = document.createElement("div");
  rows.className = "dep-rows";
  const consumerRows = consumers.map((consumer) => {
    const row = document.createElement("div");
    row.className = "dep-row";
    row.append(
      crossRoadmapMilestoneLink(
        consumer.roadmapId,
        consumer.roadmapName,
        consumer.milestoneId,
        consumer.title,
        icons.requiredInterface(14),
      ),
    );
    return row;
  });

  if (consumers.length > CONSUMER_PREVIEW_LIMIT) {
    const toggleRow = document.createElement("div");
    toggleRow.className = "dep-row";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "dep-go";
    toggleRow.append(toggle);
    rows.append(toggleRow);

    let expanded = false;
    const renderRows = (): void => {
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.replaceChildren(
        expanded ? icons.chevronDown(14) : icons.chevronRight(14),
        expanded ? "Show fewer" : `Show all ${consumers.length}`,
      );
      const visible = expanded ? consumerRows.length : CONSUMER_PREVIEW_LIMIT;
      // Keep the toggle mounted so expanding the list does not discard focus.
      for (const [index, row] of consumerRows.entries()) {
        if (index < visible) {
          if (row.parentElement !== rows) rows.insertBefore(row, toggleRow);
        } else {
          row.remove();
        }
      }
    };
    toggle.addEventListener("click", () => {
      expanded = !expanded;
      renderRows();
    });
    renderRows();
  } else {
    rows.append(...consumerRows);
  }
  group.append(head, rows);
  return group;
}

function renderMilestonePanel(body: HTMLElement, loc: MilestoneLocation): void {
  const { milestone, lane } = loc;
  const key = `ms:${milestone.id}`;
  // Don't rebuild under the user's cursor while they are typing, and don't
  // rebuild out from under a commit that is handing focus to the next field.
  if (renderedKey === key && (savingPanelField || body.contains(document.activeElement))) {
    return;
  }
  renderedKey = key;
  body.replaceChildren();
  body.style.setProperty("--c", laneColorValue(lane.color));

  const head = railHead(
    "Milestone",
    depsGraphButton({ kind: "milestone", id: milestone.id }),
    copyLinkButton(),
    closeButton(),
  );

  const crumb = crumbLine(lane.name);

  const title = titleField(milestone.title);
  // Same hook as the item panel: only one panel renders at a time, so the id
  // stays unique and focusPanelTitle serves both.
  title.control.id = PANEL_TITLE_ID;
  title.control.addEventListener("change", () => {
    const v = title.control.value.trim();
    if (v && v !== milestone.title) {
      savePanelField(() => void actions.updateMilestone(milestone.id, { title: v }));
    }
  });

  const dates = milestoneDateEditor(milestone);

  const desc = field("Description", "textarea");
  (desc.control as HTMLTextAreaElement).value = milestone.description;
  desc.control.addEventListener("change", () => {
    const v = (desc.control as HTMLTextAreaElement).value;
    if (v !== milestone.description) {
      savePanelField(() => void actions.updateMilestone(milestone.id, { description: v }));
    }
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
  const tentative = milestoneTentativeButton(milestone);
  const atRisk = milestoneRiskButton(milestone);
  if (milestone.linkage?.sourceUid) {
    tentative.disabled = true;
    tentative.title = "Tentative timing is set by the source roadmap";
    tentative.setAttribute("aria-label", tentative.title);
    atRisk.disabled = true;
    atRisk.title = "At-risk state is set by the source roadmap";
    atRisk.setAttribute("aria-label", atRisk.title);
  }
  const signals = [tentative, atRisk, milestoneFlagButton(milestone)];
  // A mirror consumes another roadmap's contract and cannot publish itself.
  if (!milestone.linkage?.sourceUid) {
    signals.unshift(milestoneIntegrationButton(milestone));
  }
  const metadata = metadataField(signals);
  const labels = labelsField(milestone.labels, (labels) =>
    void actions.updateMilestone(milestone.id, { labels }),
  );
  attrs.append(
    metadata,
    labels,
    dependenciesSection(
      { kind: "milestone", id: milestone.id },
      mirrorSourceGroup(milestone) ?? integrationConsumersGroup(milestone),
    ),
    // Last, above only the delete button: a milestone lands in the right
    // context when it is created and rarely moves after that.
    milestoneLaneSelect(milestone),
  );

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
