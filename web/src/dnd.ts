// Pointer-based drag controller for the chart:
//  - drag a bar to move it in time, across lanes, or into/out of a parent
//  - drag a bar's edge handles to adjust start/end date
//  - drag a lane's grip to reorder swimlanes
// All previews are visual only; the model is updated once on drop.

import { actions } from "./actions";
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
  const blockEl = under.closest<HTMLElement>(".block");
  const laneEl = under.closest<HTMLElement>(".lane");
  if (blockEl && Number(blockEl.dataset.itemId) !== d.id && !d.hasChildren) {
    // Hovering another top-level item: drop makes the dragged item its child.
    const pid = Number(blockEl.dataset.itemId);
    const parentLoc = state.findItem(pid);
    if (parentLoc && parentLoc.item.parentId === null) {
      d.dropParentId = pid;
      d.dropLaneId = parentLoc.item.laneId;
      blockEl.classList.add("drop-target");
      return;
    }
  }
  if (laneEl?.dataset.laneId) {
    d.dropParentId = null;
    d.dropLaneId = Number(laneEl.dataset.laneId);
    laneEl.querySelector(".lane-canvas")?.classList.add("drop-lane");
  }
}

function clearHighlights(): void {
  if (!chartEl) return;
  for (const el of chartEl.querySelectorAll(".drop-target, .drop-lane")) {
    el.classList.remove("drop-target", "drop-lane");
  }
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
