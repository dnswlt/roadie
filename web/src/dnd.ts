// Pointer-based drag controller for the chart:
//  - drag a bar to move it in time, across lanes, or into/out of a parent
//  - drag a bar's edge handles to adjust start/end date
//  - drag a lane's grip to reorder swimlanes
// All previews are visual only; the model is updated once on drop.

import { actions } from "./actions";
import { LANE_PAD, PARENT_BAR_H, CHILD_GAP, BLOCK_GAP } from "./layout";
import { state } from "./state";
import { currentScale } from "./render";
import { dayOf, formatDay, isoOf, snapToGrid, todayDay, xOf } from "./timescale";
import type { SnapMode } from "./timescale";
import type { ItemFull, ItemPatch, LaneFull } from "./types";

type Mode = "move" | "resize-l" | "resize-r";

// Magnetic snap radius in screen pixels: a resized edge snaps to a nearby
// item edge (or today) when within this distance. Small enough to keep fine
// control; hold Alt to bypass entirely.
const SNAP_PX = 7;

interface ItemDrag {
  kind: "item";
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
}

interface LaneDrag {
  kind: "lane";
  laneId: number;
  laneEl: HTMLElement;
  py: number;
  started: boolean;
  insertIndex: number;
}

let drag: ItemDrag | LaneDrag | null = null;
let tooltip: HTMLElement | null = null;
let chartEl: HTMLElement | null = null;

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
  if (e.button !== 0 || drag || !chartEl) return;
  const t = e.target as HTMLElement;

  // The bar's external-link icon is a real anchor: let its click through
  // rather than starting a drag or selecting the item.
  if (t.closest(".bar-link")) return;

  // Same for a parent's fold chevron: it is a button, not a drag handle.
  if (t.closest(".disclosure")) return;

  const grip = t.closest(".lane-grip");
  if (grip) {
    const laneEl = grip.closest<HTMLElement>(".lane");
    if (!laneEl) return;
    drag = {
      kind: "lane",
      laneId: Number(laneEl.dataset.laneId),
      laneEl,
      py: e.clientY,
      started: false,
      insertIndex: -1,
    };
    chartEl.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  const barEl = t.closest<HTMLElement>(".bar, .child-bar");
  if (!barEl) return;
  const id = Number(barEl.dataset.itemId);
  const loc = state.findItem(id);
  if (!loc) return;

  const mode: Mode = t.closest(".rh-l") ? "resize-l" : t.closest(".rh-r") ? "resize-r" : "move";
  const isChild = barEl.classList.contains("child-bar");
  const el = isChild ? barEl : (barEl.closest<HTMLElement>(".block") ?? barEl);
  const children = (loc.item as ItemFull).children;
  const container = loc.parent ? loc.parent.children : loc.lane.items;
  drag = {
    kind: "item",
    mode,
    id,
    el,
    barEl,
    origLeft: barEl.offsetLeft,
    origWidth: barEl.offsetWidth,
    origParentId: loc.item.parentId,
    origLaneId: loc.item.laneId,
    origIndex: container.findIndex((i) => i.id === id),
    hasChildren: !isChild && children.length > 0,
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
    snapBounds: collectSnapBounds(loc.lane, id),
  };
  chartEl.setPointerCapture(e.pointerId);
  e.preventDefault();
}

// collectSnapBounds gathers the boundary positions a moved bar or resized
// handle can snap to. A bar occupies pixels [xOf(start), xOf(end + 1)), so its
// edges live on the boundary grid: an item contributes `start` (its left edge)
// and `end + 1` (its right edge). Snapping edges in this domain makes "A's end
// meets B's start" come out flush instead of overlapping by the shared day.
// Included: every other item in the lane (top-level and children), every
// milestone (a point, so a single boundary), and today. The dragged bar's own
// edges are excluded.
function collectSnapBounds(lane: LaneFull, selfId: number): number[] {
  const bounds = new Set<number>();
  for (const it of lane.items) {
    if (it.id !== selfId) {
      bounds.add(dayOf(it.startDate));
      bounds.add(dayOf(it.endDate) + 1);
    }
    for (const c of it.children) {
      if (c.id !== selfId) {
        bounds.add(dayOf(c.startDate));
        bounds.add(dayOf(c.endDate) + 1);
      }
    }
  }
  for (const m of lane.milestones) {
    bounds.add(dayOf(m.date));
  }
  bounds.add(todayDay());
  return [...bounds];
}

// snapEdge returns the candidate day nearest `day` within SNAP_PX pixels, or
// `day` unchanged when nothing is close enough.
function snapEdge(day: number, cands: number[], px: number): number {
  let best = day;
  let bestDist = SNAP_PX + 1;
  for (const c of cands) {
    const dist = Math.abs(day - c) * px;
    if (dist <= SNAP_PX && dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

// snapBoundary resolves a single dragged/resized edge, given as a boundary
// position. Item-edge snapping (radius-limited) takes priority — aligning to a
// real item is the strongest intent — and only when no item boundary is close
// does the edge fall to the calendar grid. In "day" mode the grid is the
// identity, so this is pure item snapping.
function snapBoundary(bound: number, cands: number[], px: number, mode: SnapMode): number {
  const item = snapEdge(bound, cands, px);
  if (item !== bound) return item;
  return snapToGrid(bound, mode);
}

// moveBounds returns the dragged bar's two edge boundaries after a rigid shift
// of `dayDelta`: the left edge sits at start, the right edge at end + 1.
function moveBounds(d: ItemDrag, dayDelta: number): [number, number] {
  return [d.startDay + dayDelta, d.endDay + 1 + dayDelta];
}

// snapMoveToItems adjusts a move's day-offset so that whichever of the two
// (rigidly shifted) edge boundaries is closest to an item boundary lands
// exactly on it, within SNAP_PX. Returns dayDelta unchanged when nothing is
// close enough.
function snapMoveToItems(d: ItemDrag, dayDelta: number, px: number): number {
  let best = dayDelta;
  let bestDist = SNAP_PX + 1;
  for (const edge of moveBounds(d, dayDelta)) {
    for (const c of d.snapBounds) {
      const dist = Math.abs(edge - c) * px;
      if (dist <= SNAP_PX && dist < bestDist) {
        bestDist = dist;
        best = dayDelta + (c - edge);
      }
    }
  }
  return best;
}

// snapMoveDelta resolves a move. Item snapping wins when an edge boundary is
// within SNAP_PX of a real item boundary; otherwise the offset is nudged so
// whichever edge boundary is nearest a calendar-grid line lands exactly on it
// (duration preserved). The move rides the grid but "clicks" onto neighbours.
function snapMoveDelta(d: ItemDrag, dayDelta: number, px: number, mode: SnapMode): number {
  const item = snapMoveToItems(d, dayDelta, px);
  if (item !== dayDelta) return item;
  if (mode === "day") return dayDelta;
  let best = dayDelta;
  let bestDist = Infinity;
  for (const edge of moveBounds(d, dayDelta)) {
    const g = snapToGrid(edge, mode);
    const dist = Math.abs(g - edge);
    if (dist < bestDist) {
      bestDist = dist;
      best = dayDelta + (g - edge);
    }
  }
  return best;
}

function onPointerMove(e: PointerEvent): void {
  if (!drag) return;
  if (drag.kind === "lane") {
    laneDragMove(e);
    return;
  }
  const bypass = e.altKey; // hold Alt/Option to suppress snapping and coarse stepping
  const d = drag;
  const dx = e.clientX - d.px;
  const dy = e.clientY - d.py;
  if (!d.started) {
    if (Math.hypot(dx, dy) < 4) return;
    d.started = true;
    d.el.classList.add("dragging");
    d.el.style.pointerEvents = "none";
    tooltip = document.createElement("div");
    tooltip.className = "drag-tooltip";
    document.body.append(tooltip);
  }

  const px = currentScale().pxPerDay;
  const mode: SnapMode = bypass ? "day" : state.snapMode;
  const dayDelta = Math.round(dx / px);

  switch (d.mode) {
    case "move": {
      const md = bypass ? dayDelta : snapMoveDelta(d, dayDelta, px, mode);
      d.newStart = d.startDay + md;
      d.newEnd = d.endDay + md;
      d.el.style.transform = `translate(${md * px}px, ${dy}px)`;
      updateDropTarget(d, e);
      updateSnapGuide(d, bypass, d.newStart, d.newEnd + 1);
      break;
    }
    case "resize-l": {
      // The left edge is the start boundary itself.
      let s = d.startDay + dayDelta;
      if (!bypass) s = snapBoundary(s, d.snapBounds, px, mode);
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
      if (!bypass) eb = snapBoundary(eb, d.snapBounds, px, mode);
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

function updateDropTarget(d: ItemDrag, e: PointerEvent): void {
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

function elementsExcept(root: HTMLElement, selector: string, excludeId: number): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => Number(el.dataset.itemId) !== excludeId,
  );
}

// indexFromY returns the insertion index among `els` (in DOM = rank order)
// for a pointer at clientY: the number of elements whose center is above it.
function indexFromY(els: HTMLElement[], clientY: number): number {
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
function updateSnapGuide(d: ItemDrag, bypass: boolean, ...bounds: number[]): void {
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
  if (!chartEl) return;
  for (const el of chartEl.querySelectorAll(".drop-target, .drop-lane")) {
    el.classList.remove("drop-target", "drop-lane");
  }
  removeInsertLine();
  removeSnapGuide();
}

function onPointerUp(e: PointerEvent): void {
  if (!drag) return;
  if (drag.kind === "lane") {
    laneDragEnd();
    return;
  }
  const d = drag;
  resetItemVisuals(d);
  drag = null;

  if (!d.started) {
    // Plain click: select the item and show the edit panel.
    state.selectItem(d.id);
    state.notify();
    return;
  }

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

function resetItemVisuals(d: ItemDrag): void {
  d.el.classList.remove("dragging");
  d.el.style.pointerEvents = "";
  d.el.style.transform = "";
  d.barEl.style.left = "";
  d.barEl.style.width = "";
  clearHighlights();
  tooltip?.remove();
  tooltip = null;
}

function cancelDrag(): void {
  if (!drag) return;
  if (drag.kind === "item") {
    resetItemVisuals(drag);
  } else {
    drag.laneEl.classList.remove("lane-dragging");
    removeLaneIndicator();
  }
  drag = null;
}

// Lane reordering

function laneEls(): HTMLElement[] {
  return chartEl ? Array.from(chartEl.querySelectorAll<HTMLElement>(".lane")) : [];
}

function laneDragMove(e: PointerEvent): void {
  const d = drag as LaneDrag;
  if (!d.started) {
    if (Math.abs(e.clientY - d.py) < 4) return;
    d.started = true;
    d.laneEl.classList.add("lane-dragging");
  }
  const els = laneEls();
  let idx = els.length;
  for (let i = 0; i < els.length; i++) {
    const r = els[i]!.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) {
      idx = i;
      break;
    }
  }
  d.insertIndex = idx;
  showLaneIndicator(els, idx);
}

function showLaneIndicator(els: HTMLElement[], idx: number): void {
  removeLaneIndicator();
  const lanes = chartEl?.querySelector<HTMLElement>(".lanes");
  if (!lanes || els.length === 0) return;
  const ind = document.createElement("div");
  ind.className = "lane-insert";
  const lanesRect = lanes.getBoundingClientRect();
  const y =
    idx < els.length
      ? els[idx]!.getBoundingClientRect().top - lanesRect.top
      : els[els.length - 1]!.getBoundingClientRect().bottom - lanesRect.top;
  ind.style.top = `${y - 1 + lanes.scrollTop}px`;
  lanes.append(ind);
}

function removeLaneIndicator(): void {
  chartEl?.querySelector(".lane-insert")?.remove();
}

function laneDragEnd(): void {
  const d = drag as LaneDrag;
  d.laneEl.classList.remove("lane-dragging");
  removeLaneIndicator();
  drag = null;
  if (!d.started || !state.current || d.insertIndex < 0) return;

  const ids = state.current.lanes.map((l) => l.id);
  const from = ids.indexOf(d.laneId);
  if (from < 0) return;
  let to = d.insertIndex;
  ids.splice(from, 1);
  if (to > from) to--;
  ids.splice(to, 0, d.laneId);
  const changed = ids.some((id, i) => id !== state.current!.lanes[i]!.id);
  if (changed) void actions.reorderLanes(ids);
}
