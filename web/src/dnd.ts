// Pointer-based drag controller for the chart:
//  - drag a bar to move it in time, across lanes, or into/out of a parent
//  - drag a bar's edge handles to adjust start/end date
// All previews are visual only; the model is updated once on drop.
// While a filter is active, bar moves pause because the hidden structure
// makes a drop ambiguous; resize handles remain active.
//
// The snapping math lives in snap.ts (DOM-free, tested); this file collects the
// candidate boundaries, reads the modifier keys, and applies the result.

import { actions } from "./actions";
import { canDrag, DRAG_BLOCKED_HINT } from "./filter";
import { LANE_PAD, PARENT_BAR_H, CHILD_GAP, BLOCK_GAP } from "./layout";
import { DoubleClickDetector } from "./gesture";
import { focusPanelTitle } from "./panel";
import { scheduleBounds } from "./schedule";
import { gridSnapper, snapBoundary, snapMoveDelta } from "./snap";
import { state } from "./state";
import { toast } from "./toast";
import { currentScale } from "./render";
import { dayOf, formatDay, isoOf, todayDay, xOf } from "./timescale";
import type { ItemFull, ItemPatch, LaneFull } from "./types";

type Mode = "move" | "resize-l" | "resize-r";

interface Drag {
  mode: Mode;
  id: number;
  el: HTMLElement; // element that moves: .block (top-level) or .child-bar
  barEl: HTMLElement; // element that resizes: .bar or .child-bar
  origLeft: number;
  origWidth: number;
  origParentId: number | null;
  origLaneId: number;
  origIndex: number; // index within the container array
  hasChildren: boolean;
  startDay: number;
  endDay: number;
  px: number;
  py: number;
  started: boolean;
  newStart: number;
  newEnd: number;
  dropLaneId: number;
  dropParentId: number | null;
  dropRank: number | null; // insertion index in the drop container; null = keep/append
  snapBounds: number[]; // candidate boundary positions a dragged edge snaps to
  scheduleBounds: number[]; // schedule-period boundaries, the grid for "schedule" snap mode
  // A single-item drag is just a group drag of one member: `members` are the
  // elements translated as a live preview, and the drag snaps around one
  // anchor (this item). A group drag (isGroup) shifts several items in time
  // together — horizontal only, no structure — and commits via `memberIds`.
  isGroup: boolean;
  members: HTMLElement[];
  memberIds: number[];
  moveSuppressed: boolean; // this move was disabled by the active filter at pointer-down
  suppressedDragRecognized: boolean; // crossed 4px; pointer-up must not synthesize a click
}

let drag: Drag | null = null;
let tooltip: HTMLElement | null = null;
let chartEl: HTMLElement;

// Double-click-to-rename on bars (see the click branch in onPointerUp).
const dblClick = new DoubleClickDetector();

// isDragging reports whether a pointer gesture is actually in progress (past
// its start threshold). The live-update safe-gate uses it to defer a remote
// refresh until the gesture completes, rather than yanking the chart out from
// under a drag.
export function isDragging(): boolean {
  return drag?.started === true;
}

export function initDnd(chart: HTMLElement): void {
  chartEl = chart;
  chart.addEventListener("pointerdown", onPointerDown);
  chart.addEventListener("pointermove", onPointerMove);
  chart.addEventListener("pointerup", onPointerUp);
  chart.addEventListener("pointercancel", () => cancelDrag());
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drag) {
      cancelDrag();
      e.stopPropagation();
    }
  });
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || drag) return;
  // No gestures while previewing a snapshot: the view is read-only (see
  // actions.optimistic). Bailing here avoids a drag preview that couldn't commit.
  if (state.preview) return;
  const t = e.target as HTMLElement;

  // The bar's external-link icon is a real anchor: let its click through
  // rather than starting a drag or selecting the item.
  if (t.closest(".bar-link")) return;

  // Same for a parent's fold chevron: it is a button, not a drag handle.
  if (t.closest(".disclosure")) return;

  const barEl = t.closest<HTMLElement>(".bar, .child-bar");
  if (!barEl) {
    // A press on anything that is not a bar (milestone, empty canvas, lane
    // label) breaks a pending rename pair.
    dblClick.reset();
    return;
  }
  const id = Number(barEl.dataset.itemId);
  const loc = state.findItem(id);
  if (!loc) return;

  // Grabbing any visible member of a multi-selection drags the visible group
  // in time. A filter or hidden lane can leave only one selected item on the
  // chart; in that case it keeps the normal single-item resize/structure
  // gestures rather than acting like an invisible group still exists.
  const visibleSelected = [...state.selectedItemIds].filter((selectedId) =>
    chartEl.querySelector(
      `.block[data-item-id="${selectedId}"], .child-bar[data-item-id="${selectedId}"]`,
    ),
  );
  const isGroup =
    state.hasMultiSelection() && state.isItemSelected(id) && visibleSelected.length > 1;
  // A group drag is move-only; a resize handle grabbed on a member still moves.
  const mode: Mode = isGroup
    ? "move"
    : t.closest(".rh-l")
      ? "resize-l"
      : t.closest(".rh-r")
        ? "resize-r"
        : "move";
  const isChild = barEl.classList.contains("child-bar");
  const el = isChild ? barEl : (barEl.closest<HTMLElement>(".block") ?? barEl);
  const children = (loc.item as ItemFull).children;
  const container = loc.parent ? loc.parent.children : loc.lane.items;
  const hasChildren = !isChild && children.length > 0;
  const { exclude, members } = collectDragMembers(
    chartEl,
    id,
    el,
    mode === "move" && hasChildren,
    children,
    isGroup,
  );
  drag = {
    mode,
    id,
    el,
    barEl,
    origLeft: barEl.offsetLeft,
    origWidth: barEl.offsetWidth,
    origParentId: loc.item.parentId,
    origLaneId: loc.item.laneId,
    origIndex: container.findIndex((i) => i.id === id),
    hasChildren,
    startDay: dayOf(loc.item.startDate),
    endDay: dayOf(loc.item.endDate),
    px: e.clientX,
    py: e.clientY,
    started: false,
    newStart: dayOf(loc.item.startDate),
    newEnd: dayOf(loc.item.endDate),
    dropLaneId: loc.item.laneId,
    dropParentId: loc.item.parentId,
    dropRank: null,
    snapBounds: collectSnapBounds(loc.lane, exclude),
    scheduleBounds: state.current ? scheduleBounds(state.current.periods) : [],
    isGroup,
    members,
    memberIds: [...exclude],
    moveSuppressed: !canDrag(state.filter, mode === "move" ? "move" : "resize"),
    suppressedDragRecognized: false,
  };
  // Capture is deferred to drag start (onPointerMove) so a plain click isn't
  // captured — otherwise Safari/Firefox retarget the click to the capture
  // element and the selection is cleared before the panel can open.
  e.preventDefault();
}

// collectSnapBounds gathers the boundary positions a moved bar or resized
// handle can snap to. A bar occupies pixels [xOf(start), xOf(end + 1)), so its
// edges live on the boundary grid: an item contributes `start` (its left edge)
// and `end + 1` (its right edge). Snapping edges in this domain makes "A's end
// meets B's start" come out flush instead of overlapping by the shared day.
//
// Targets are the lane's other visible items (top-level and children alike),
// its milestones (a point in time, so one boundary each), and today. "Visible"
// is asked of the projection rather than recomputed, so a magnet can never
// disagree with what was drawn. Two other kinds of edge are deliberately left
// off the grid:
//
//  - the children of a folded parent, which are not on screen; a bar sticking
//    to an edge the user cannot see reads as a broken snap
//  - every item in `exclude`: the ids that travel with this drag (the dragged
//    item, a moved parent's children, or all members of a group). A move
//    shifts them by the same delta, so their edges run away as fast as the
//    drag chases them. (A resize excludes only the dragged bar itself, so its
//    children stay put and remain valid targets.)
function collectSnapBounds(lane: LaneFull, exclude: Set<number>): number[] {
  const bounds = new Set<number>();
  const projection = state.projection();
  for (const it of lane.items) {
    if (!projection.drawnItemIds.has(it.id)) continue;
    if (!exclude.has(it.id)) {
      bounds.add(dayOf(it.startDate));
      bounds.add(dayOf(it.endDate) + 1);
    }
    for (const c of it.children) {
      if (projection.drawnItemIds.has(c.id) && !exclude.has(c.id)) {
        bounds.add(dayOf(c.startDate));
        bounds.add(dayOf(c.endDate) + 1);
      }
    }
  }
  for (const m of lane.milestones) {
    if (projection.drawnMilestoneIds.has(m.id)) bounds.add(dayOf(m.date));
  }
  bounds.add(todayDay());
  return [...bounds];
}

// collectDragMembers resolves who travels with a drag that started on `id`.
// Returns the set of item ids whose edges are excluded from snapping and whose
// dates shift on a group drop, plus the DOM elements to translate as a preview.
//
//  - Single drag: just `id`, plus the item's children when a parent is *moved*
//    (they follow it; a resize leaves them put). One preview element: `el`.
//  - Group drag: every selected item and the children of every selected
//    top-level member. Preview elements are each selected top-level `.block`
//    (its children ride inside it) and each selected child's own bar. A parent
//    and its child are never both selected (see toggleItem), so no child is
//    ever translated twice.
function collectDragMembers(
  chart: HTMLElement,
  id: number,
  el: HTMLElement,
  moveWithChildren: boolean,
  children: ItemFull["children"],
  isGroup: boolean,
): { exclude: Set<number>; members: HTMLElement[] } {
  const exclude = new Set<number>();
  const members: HTMLElement[] = [];
  if (!isGroup) {
    exclude.add(id);
    if (moveWithChildren) for (const c of children) exclude.add(c.id);
    members.push(el);
    return { exclude, members };
  }
  for (const selId of state.selectedItemIds) {
    const loc = state.findItem(selId);
    if (!loc) continue;
    if (loc.parent === null) {
      const block = chart.querySelector<HTMLElement>(`.block[data-item-id="${selId}"]`);
      // A selection can become hidden after it was made (the filter or lane
      // visibility). It must not join a group drag whose preview cannot show it.
      if (!block) continue;
      exclude.add(selId);
      // Children aren't in the selection but travel with their parent: exclude
      // their edges from snapping and shift their dates on drop.
      for (const c of (loc.item as ItemFull).children) exclude.add(c.id);
      members.push(block);
    } else {
      // A selected child never has a selected parent (toggleItem's invariant),
      // so it always moves on its own bar — never doubly, via a parent block
      // that would also carry it.
      const bar = chart.querySelector<HTMLElement>(`.child-bar[data-item-id="${selId}"]`);
      if (!bar) continue;
      exclude.add(selId);
      members.push(bar);
    }
  }
  return { exclude, members };
}

function onPointerMove(e: PointerEvent): void {
  if (!drag) return;
  const bypass = e.altKey; // hold Alt/Option to suppress snapping and coarse stepping
  const gridOnly = e.shiftKey; // hold Shift to snap only to the selected granularity (drop feature magnets)
  const d = drag;
  const dx = e.clientX - d.px;
  const dy = e.clientY - d.py;
  if (d.moveSuppressed) {
    if (!d.suppressedDragRecognized && Math.hypot(dx, dy) >= 4) {
      d.suppressedDragRecognized = true;
      dblClick.reset();
      toast(DRAG_BLOCKED_HINT);
      // Capture only after this is clearly an attempted drag, so release is
      // observed even if the pointer leaves the chart. No preview is started.
      chartEl.setPointerCapture(e.pointerId);
    }
    return;
  }
  if (!d.started) {
    if (Math.hypot(dx, dy) < 4) return;
    d.started = true;
    chartEl.setPointerCapture(e.pointerId); // now dragging: keep events if the pointer leaves the chart
    for (const m of d.members) {
      m.classList.add("dragging");
      m.style.pointerEvents = "none";
    }
    if (d.isGroup) chartEl.classList.add("group-dragging");
    tooltip = document.createElement("div");
    tooltip.className = "drag-tooltip";
    document.body.append(tooltip);
  }

  const px = currentScale().pxPerDay;
  // Alt is handled here rather than in snap.ts: it suppresses the feature magnets
  // as well as the grid, so each branch below skips snapping outright.
  const grid = gridSnapper(state.snapMode, d.scheduleBounds);
  // Feature magnets (other items' edges, milestones, today). Shift drops them so
  // only the selected granularity's grid snaps — calmer when a coarse grid
  // (quarter / schedule) would otherwise fight nearby features.
  const cands = gridOnly ? [] : d.snapBounds;
  const dayDelta = Math.round(dx / px);

  switch (d.mode) {
    case "move": {
      const md = bypass ? dayDelta : snapMoveDelta(d.startDay, d.endDay, dayDelta, px, cands, grid);
      d.newStart = d.startDay + md;
      d.newEnd = d.endDay + md;
      // Group drag is horizontal only; a single drag follows the pointer's Y.
      const ty = d.isGroup ? 0 : dy;
      for (const m of d.members) m.style.transform = `translate(${md * px}px, ${ty}px)`;
      if (!d.isGroup) updateDropTarget(d, e); // no structural drop target for a group
      updateSnapGuide(d, bypass, d.newStart, d.newEnd + 1);
      break;
    }
    case "resize-l": {
      // The left edge is the start boundary itself.
      let s = d.startDay + dayDelta;
      if (!bypass) s = snapBoundary(s, cands, px, grid);
      d.newStart = Math.min(s, d.endDay);
      d.newEnd = d.endDay;
      const shift = (d.newStart - d.startDay) * px;
      d.barEl.style.left = `${d.origLeft + shift}px`;
      d.barEl.style.width = `${d.origWidth - shift}px`;
      updateSnapGuide(d, bypass, d.newStart);
      break;
    }
    case "resize-r": {
      // The right edge lives at end + 1; snap there, then convert back.
      let eb = d.endDay + 1 + dayDelta;
      if (!bypass) eb = snapBoundary(eb, cands, px, grid);
      d.newStart = d.startDay;
      d.newEnd = Math.max(eb - 1, d.startDay);
      d.barEl.style.width = `${d.origWidth + (d.newEnd - d.endDay) * px}px`;
      updateSnapGuide(d, bypass, d.newEnd + 1);
      break;
    }
  }

  if (tooltip) {
    tooltip.textContent =
      d.newStart === d.newEnd
        ? formatDay(d.newStart)
        : `${formatDay(d.newStart)} – ${formatDay(d.newEnd)}`;
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 18}px`;
  }
}

function updateDropTarget(d: Drag, e: PointerEvent): void {
  const under = document.elementFromPoint(e.clientX, e.clientY);
  clearHighlights();
  if (!under) return;

  // Nesting: only a top-level item's header bar is a nest target. Everything
  // else in a lane means "insert as top-level at this vertical position".
  const barUnder = under.closest<HTMLElement>(".bar");
  if (barUnder && Number(barUnder.dataset.itemId) !== d.id && !d.hasChildren) {
    const pid = Number(barUnder.dataset.itemId);
    const parentLoc = state.findItem(pid);
    if (parentLoc && parentLoc.item.parentId === null) {
      d.dropParentId = pid;
      d.dropLaneId = parentLoc.item.laneId;
      d.dropRank = null; // append (or keep position when re-dropped on own parent)
      barUnder.classList.add("drop-target");
      return;
    }
  }

  const laneEl = under.closest<HTMLElement>(".lane");
  const canvas = laneEl?.querySelector<HTMLElement>(".lane-canvas");
  if (!laneEl?.dataset.laneId || !canvas) return;

  // A child dragged within its own parent's block: reorder among siblings.
  const blockUnder = under.closest<HTMLElement>(".block");
  if (d.origParentId !== null && blockUnder && Number(blockUnder.dataset.itemId) === d.origParentId) {
    const siblings = elementsExcept(blockUnder, ".child-bar", d.id);
    d.dropParentId = d.origParentId;
    d.dropLaneId = d.origLaneId;
    d.dropRank = indexFromY(siblings, e.clientY);
    showInsertLine(blockUnder, siblings, d.dropRank, PARENT_BAR_H + CHILD_GAP / 2);
    return;
  }

  // Top-level insertion into the lane at the pointer's vertical position.
  const blocks = elementsExcept(canvas, ".block", d.id);
  d.dropParentId = null;
  d.dropLaneId = Number(laneEl.dataset.laneId);
  d.dropRank = indexFromY(blocks, e.clientY);
  showInsertLine(canvas, blocks, d.dropRank, LANE_PAD);
  canvas.classList.add("drop-lane");
}

// elementsExcept and indexFromY are shared with wbs-dnd.ts: resolving "which
// slot is the pointer over" is the same geometry in both views, even though
// the elements it runs over never are.
export function elementsExcept(root: HTMLElement, selector: string, excludeId: number): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => Number(el.dataset.itemId) !== excludeId,
  );
}

// indexFromY returns the insertion index among `els` (in DOM = rank order)
// for a pointer at clientY: the number of elements whose center is above it.
export function indexFromY(els: HTMLElement[], clientY: number): number {
  let idx = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (clientY > r.top + r.height / 2) idx++;
  }
  return idx;
}

function showInsertLine(container: HTMLElement, els: HTMLElement[], idx: number, emptyY: number): void {
  removeInsertLine();
  const line = document.createElement("div");
  line.className = "item-insert";
  const cr = container.getBoundingClientRect();
  const gap = container.classList.contains("block") ? CHILD_GAP : BLOCK_GAP;
  let y: number;
  if (els.length === 0) {
    y = emptyY;
  } else if (idx <= 0) {
    y = els[0]!.getBoundingClientRect().top - cr.top - gap / 2;
  } else if (idx >= els.length) {
    y = els[els.length - 1]!.getBoundingClientRect().bottom - cr.top + gap / 2;
  } else {
    const above = els[idx - 1]!.getBoundingClientRect().bottom;
    const below = els[idx]!.getBoundingClientRect().top;
    y = (above + below) / 2 - cr.top;
  }
  line.style.top = `${y}px`;
  container.append(line);
}

function removeInsertLine(): void {
  document.querySelector(".item-insert")?.remove();
}

// updateSnapGuide draws a full-height guide line at the first of `bounds` (edge
// boundary positions) that has landed exactly on a snap candidate; otherwise it
// clears the guide. When snapping is bypassed the guide is always cleared — no
// alignment assistance. The line sits at the boundary's pixel column, which is
// the bar edge itself (xOf(end + 1) for a right edge).
function updateSnapGuide(d: Drag, bypass: boolean, ...bounds: number[]): void {
  removeSnapGuide();
  if (bypass) return;
  const bound = bounds.find((b) => d.snapBounds.includes(b));
  if (bound === undefined) return;
  const canvas = d.barEl.closest<HTMLElement>(".lane-canvas");
  if (!canvas) return;
  const line = document.createElement("div");
  line.className = "snap-guide";
  line.style.left = `${xOf(currentScale(), bound)}px`;
  canvas.append(line);
}

function removeSnapGuide(): void {
  document.querySelector(".snap-guide")?.remove();
}

function clearHighlights(): void {
  for (const el of chartEl.querySelectorAll(".drop-target, .drop-lane")) {
    el.classList.remove("drop-target", "drop-lane");
  }
  removeInsertLine();
  removeSnapGuide();
}

function onPointerUp(e: PointerEvent): void {
  if (!drag) return;
  const d = drag;
  resetVisuals(d);
  drag = null;

  if (d.suppressedDragRecognized) return;

  if (!d.started) {
    // A click, not a drag. Shift-click toggles the item in the multi-selection;
    // a plain click selects it alone and shows the edit panel; two plain clicks
    // in quick succession jump into renaming it there — detected by hand
    // because onPointerDown's preventDefault suppresses native click/dblclick
    // on bars (see AGENTS.md).
    if (e.shiftKey) {
      dblClick.reset(); // a Shift-click is selection-building, not a rename pair
      state.toggleItem(d.id);
      state.notifySelection();
      return;
    }
    const isDouble = dblClick.click({ id: d.id, x: e.clientX, y: e.clientY, at: e.timeStamp });
    state.selectItem(d.id);
    state.notifySelection();
    if (isDouble) focusPanelTitle();
    return;
  }
  // A completed drag is not a click: click-jiggle-click must not read as a double.
  dblClick.reset();

  // Group drag: shift every member in time by the same delta. No structure.
  if (d.isGroup) {
    const dayDelta = d.newStart - d.startDay;
    if (dayDelta !== 0) void actions.shiftItems(d.memberIds, dayDelta);
    else state.notify(); // no net change — re-render to discard the preview
    return;
  }

  // A single-item drag ends any lingering multi-selection: the user is now
  // manipulating one item, so collapse back to a single (soon: none) selection.
  if (state.hasMultiSelection()) state.clearSelection();

  // Unfold the parent an item was just nested into, so it doesn't vanish into
  // a folded block. Done here rather than on hover: setCollapsed re-renders,
  // which mid-drag would destroy the element being dragged.
  const nestedInto = d.dropParentId;
  if (nestedInto !== null && nestedInto !== d.origParentId && state.isCollapsed(nestedInto)) {
    state.setCollapsed(nestedInto, false);
  }

  const patch: ItemPatch = {};
  if (d.newStart !== d.startDay) patch.startDate = isoOf(d.newStart);
  if (d.newEnd !== d.endDay) patch.endDate = isoOf(d.newEnd);
  if (d.mode === "move") {
    if (d.dropParentId !== d.origParentId) patch.parentId = d.dropParentId;
    if (d.dropParentId === null && d.dropLaneId !== d.origLaneId) patch.laneId = d.dropLaneId;
    const containerChanged = d.dropParentId !== d.origParentId || d.dropLaneId !== d.origLaneId;
    if (d.dropRank !== null && (containerChanged || d.dropRank !== d.origIndex)) {
      patch.rank = d.dropRank;
    }
  }
  if (Object.keys(patch).length > 0) {
    const dayDelta = d.newStart - d.startDay;
    if (d.mode === "move" && d.hasChildren && dayDelta !== 0) {
      void actions.moveItemWithChildren(d.id, patch, dayDelta);
    } else {
      void actions.updateItem(d.id, patch);
    }
  } else {
    // Drag ended with no net change, so no mutation re-renders the chart.
    // Re-render from the model anyway to discard the drag preview: resetting
    // a child bar's inline left/width alone would leave it mispositioned
    // (its layout comes from those inline styles, not CSS).
    state.notify();
  }
}

function resetVisuals(d: Drag): void {
  // `started` gates every preview mutation, so before it there is nothing to
  // reset — and clearing anyway would wipe a child bar's inline left/width
  // (its only geometry), which no full re-render repairs on a click anymore.
  if (!d.started) return;
  for (const m of d.members) {
    m.classList.remove("dragging");
    m.style.pointerEvents = "";
    m.style.transform = "";
  }
  d.barEl.style.left = "";
  d.barEl.style.width = "";
  chartEl.classList.remove("group-dragging");
  clearHighlights();
  tooltip?.remove();
  tooltip = null;
}

function cancelDrag(): void {
  if (!drag) return;
  const d = drag;
  drag = null;
  dblClick.reset();
  resetVisuals(d);
  // A started resize preview overwrote the bar's inline left/width, and for
  // a child bar those are its only geometry — clearing them cannot bring the
  // originals back, so rebuild from the model. (Previously this repair came
  // accidentally, from the Esc keybinding's full notify on deselect.)
  if (d.started) state.notify();
}
