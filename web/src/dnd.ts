// Pointer-based drag controller for the chart:
//  - drag a bar to move it in time, across lanes, or into/out of a parent
//  - drag a bar's edge handles to adjust start/end date
//  - drag a lane's grip to reorder swimlanes
// All previews are visual only; the model is updated once on drop.

import { actions } from "./actions";
import { LANE_PAD, PARENT_BAR_H } from "./layout";
import { state } from "./state";
import { currentScale } from "./render";
import { dayOf, formatDay, isoOf } from "./timescale";
import type { ItemFull, ItemPatch } from "./types";

type Mode = "move" | "resize-l" | "resize-r";

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
  };
  chartEl.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (!drag) return;
  if (drag.kind === "lane") {
    laneDragMove(e);
    return;
  }
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
  const dayDelta = Math.round(dx / px);

  switch (d.mode) {
    case "move": {
      d.newStart = d.startDay + dayDelta;
      d.newEnd = d.endDay + dayDelta;
      d.el.style.transform = `translate(${dayDelta * px}px, ${dy}px)`;
      updateDropTarget(d, e);
      break;
    }
    case "resize-l": {
      d.newStart = Math.min(d.startDay + dayDelta, d.endDay);
      d.newEnd = d.endDay;
      const shift = (d.newStart - d.startDay) * px;
      d.barEl.style.left = `${d.origLeft + shift}px`;
      d.barEl.style.width = `${d.origWidth - shift}px`;
      break;
    }
    case "resize-r": {
      d.newStart = d.startDay;
      d.newEnd = Math.max(d.endDay + dayDelta, d.startDay);
      d.barEl.style.width = `${d.origWidth + (d.newEnd - d.endDay) * px}px`;
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
    showInsertLine(blockUnder, siblings, d.dropRank, PARENT_BAR_H + 2);
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
  let y: number;
  if (els.length === 0) {
    y = emptyY;
  } else if (idx <= 0) {
    y = els[0]!.getBoundingClientRect().top - cr.top - 4;
  } else if (idx >= els.length) {
    y = els[els.length - 1]!.getBoundingClientRect().bottom - cr.top + 3;
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

function clearHighlights(): void {
  if (!chartEl) return;
  for (const el of chartEl.querySelectorAll(".drop-target, .drop-lane")) {
    el.classList.remove("drop-target", "drop-lane");
  }
  removeInsertLine();
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
    state.selectedItemId = d.id;
    state.notify();
    return;
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
    void actions.updateItem(d.id, patch);
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
