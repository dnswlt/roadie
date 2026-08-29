// Pointer controller for the WBS outline: the structural half of dnd.ts with
// the time axis gone. Drag a row vertically to reorder it among its siblings,
// drop it on a top-level row to nest under it, or carry it into another lane
// — plus the click handling that pointerdown's preventDefault makes manual
// (same mechanics as dnd.ts: capture deferred to drag start, double clicks
// hand-detected). All previews are visual only; the model is updated once on
// drop, through the same ItemPatch vocabulary the timeline uses — rank,
// parentId, laneId, never dates. A WBS move means "same time, different place
// in the breakdown". Item moves pause while filtering because the breakdown
// is then incomplete; rows remain selectable through the same controller.
//
// Deliberately blind to the timeline's DOM: this file matches only .wbs-*
// classes, as dnd.ts matches only .bar/.child-bar. Neither
// controller can see the other's elements, so neither needs a view-mode gate.

import { actions } from "./actions";
import { elementsExcept, indexFromY } from "./dnd";
import { canDrag, DRAG_BLOCKED_HINT } from "./filter";
import { DoubleClickDetector } from "./gesture";
import { focusPanelTitle } from "./panel";
import { state } from "./state";
import { toast } from "./toast";
import type { ItemFull, ItemPatch } from "./types";

interface WbsDrag {
  id: number;
  el: HTMLElement; // element that moves: .wbs-block (top-level) or .wbs-row.wbs-child
  origParentId: number | null;
  origLaneId: number;
  origIndex: number; // index within the container array
  hasChildren: boolean;
  px: number;
  py: number;
  started: boolean;
  dropLaneId: number;
  dropParentId: number | null;
  dropRank: number | null; // insertion index in the drop container; null = keep/append
  moveSuppressed: boolean; // this move was disabled by the active item filter at pointer-down
  suppressedDragRecognized: boolean; // crossed 4px; pointer-up must not synthesize a click
}

// Vertical rhythm of .wbs-rows / .wbs-block, mirrored from styles.css: blocks
// are 8px apart, child rows touch.
const WBS_BLOCK_GAP = 8;
const WBS_CHILD_GAP = 0;
const WBS_ROWS_PAD = 10; // .wbs-rows top padding, the empty-lane insert position
const WBS_ROW_H = 30; // a parent row's height, the empty-block insert position

let drag: WbsDrag | null = null;
let chartEl: HTMLElement | null = null;

const dblClick = new DoubleClickDetector();

// isWbsDragging is the WBS twin of dnd.isDragging, for the live-update
// safe-gate in events.ts: a refresh mid-drag would rebuild the outline under
// the pointer.
export function isWbsDragging(): boolean {
  return drag?.started === true;
}

export function initWbsDnd(chart: HTMLElement): void {
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
  // No gestures while previewing a snapshot — same gate as dnd.ts, so rows
  // and bars go equally quiet in a preview.
  if (state.preview) return;
  const t = e.target as HTMLElement;

  // The link icon is a real anchor and the fold chevron a real button: let
  // their clicks through (app.ts wireChart owns the chevron's).
  if (t.closest(".bar-link")) return;
  if (t.closest(".disclosure")) return;

  const rowEl = t.closest<HTMLElement>(".wbs-row");
  if (!rowEl) {
    // A press on anything that is not a row breaks a pending rename pair.
    dblClick.reset();
    return;
  }
  const id = Number(rowEl.dataset.itemId);
  const loc = state.findItem(id);
  if (!loc) return;

  const isChild = rowEl.classList.contains("wbs-child");
  // A top-level item drags as its whole block, so its children ride along —
  // the same thing a moved parent's bars do on the timeline.
  const el = isChild ? rowEl : (rowEl.closest<HTMLElement>(".wbs-block") ?? rowEl);
  const container = loc.parent ? loc.parent.children : loc.lane.items;
  drag = {
    id,
    el,
    origParentId: loc.item.parentId,
    origLaneId: loc.item.laneId,
    origIndex: container.findIndex((i) => i.id === id),
    hasChildren: !isChild && (loc.item as ItemFull).children.length > 0,
    px: e.clientX,
    py: e.clientY,
    started: false,
    dropLaneId: loc.item.laneId,
    dropParentId: loc.item.parentId,
    dropRank: null,
    moveSuppressed: !canDrag(state.filter, "move"),
    suppressedDragRecognized: false,
  };
  // As in dnd.ts: preventDefault here (drags must not start text selections),
  // which suppresses native click/dblclick on rows — so both are re-created
  // by hand in onPointerUp — and capture is deferred to drag start so a plain
  // click isn't retargeted by Safari/Firefox.
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (!drag) return;
  const d = drag;
  const dy = e.clientY - d.py;
  if (d.moveSuppressed) {
    if (!d.suppressedDragRecognized && Math.hypot(e.clientX - d.px, dy) >= 4) {
      d.suppressedDragRecognized = true;
      dblClick.reset();
      toast(DRAG_BLOCKED_HINT);
      chartEl?.setPointerCapture(e.pointerId);
    }
    return;
  }
  if (!d.started) {
    if (Math.hypot(e.clientX - d.px, dy) < 4) return;
    d.started = true;
    chartEl?.setPointerCapture(e.pointerId); // now dragging: keep events if the pointer leaves the chart
    d.el.classList.add("dragging");
    d.el.style.pointerEvents = "none"; // so elementFromPoint sees the drop target beneath
  }
  // The preview follows the pointer vertically only: there is no horizontal
  // dimension to move in, and a row sliding sideways would suggest one.
  d.el.style.transform = `translateY(${dy}px)`;
  updateDropTarget(d, e);
}

function updateDropTarget(d: WbsDrag, e: PointerEvent): void {
  const under = document.elementFromPoint(e.clientX, e.clientY);
  clearHighlights();
  if (!under) return;

  // Nesting: only a top-level item's own row is a nest target (its children's
  // rows are not — they mean "reorder here"), and only a childless item can
  // nest (one level deep, the store invariant).
  const rowUnder = under.closest<HTMLElement>(".wbs-row");
  if (
    rowUnder &&
    !rowUnder.classList.contains("wbs-child") &&
    Number(rowUnder.dataset.itemId) !== d.id &&
    !d.hasChildren
  ) {
    const pid = Number(rowUnder.dataset.itemId);
    const parentLoc = state.findItem(pid);
    if (parentLoc && parentLoc.item.parentId === null) {
      d.dropParentId = pid;
      d.dropLaneId = parentLoc.item.laneId;
      d.dropRank = null; // append (or keep position when re-dropped on own parent)
      rowUnder.classList.add("drop-target");
      return;
    }
  }

  const laneEl = under.closest<HTMLElement>(".lane");
  const rowsEl = laneEl?.querySelector<HTMLElement>(".wbs-rows");
  if (!laneEl?.dataset.laneId || !rowsEl) return;

  // A child dragged within its own parent's block: reorder among siblings.
  const blockUnder = under.closest<HTMLElement>(".wbs-block");
  if (d.origParentId !== null && blockUnder && Number(blockUnder.dataset.itemId) === d.origParentId) {
    const siblings = elementsExcept(blockUnder, ".wbs-row.wbs-child", d.id);
    d.dropParentId = d.origParentId;
    d.dropLaneId = d.origLaneId;
    d.dropRank = indexFromY(siblings, e.clientY);
    showInsertLine(blockUnder, siblings, d.dropRank);
    return;
  }

  // Top-level insertion into the lane at the pointer's vertical position.
  const blocks = elementsExcept(rowsEl, ".wbs-block", d.id);
  d.dropParentId = null;
  d.dropLaneId = Number(laneEl.dataset.laneId);
  d.dropRank = indexFromY(blocks, e.clientY);
  showInsertLine(rowsEl, blocks, d.dropRank);
}

// showInsertLine draws the insertion indicator between `els` (blocks of a
// lane, or child rows of a block) at slot `idx`. Same .item-insert element the
// timeline uses — display only, never hit-tested. The empty-target positions
// avoid measuring anything that travels with the drag (a translated rect
// would put the line where the preview happens to hover): a bare block's line
// sits under its parent row, a bare lane's under whatever milestone furniture
// precedes the blocks, or at the top padding.
function showInsertLine(container: HTMLElement, els: HTMLElement[], idx: number): void {
  removeInsertLine();
  const line = document.createElement("div");
  line.className = "item-insert";
  const cr = container.getBoundingClientRect();
  const inBlock = container.classList.contains("wbs-block");
  const gap = inBlock ? WBS_CHILD_GAP : WBS_BLOCK_GAP;
  let y: number;
  if (els.length === 0) {
    if (inBlock) {
      y = WBS_ROW_H;
    } else {
      const pre = Array.from(container.children).filter(
        (el) => !el.classList.contains("wbs-block") && !el.classList.contains("item-insert"),
      );
      const last = pre[pre.length - 1];
      y = last ? last.getBoundingClientRect().bottom - cr.top + WBS_BLOCK_GAP / 2 : WBS_ROWS_PAD;
    }
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

function clearHighlights(): void {
  if (!chartEl) return;
  for (const el of chartEl.querySelectorAll(".drop-target")) el.classList.remove("drop-target");
  removeInsertLine();
}

function onPointerUp(e: PointerEvent): void {
  if (!drag) return;
  const d = drag;
  resetVisuals(d);
  drag = null;

  if (d.suppressedDragRecognized) return;

  if (!d.started) {
    // A click, not a drag — same manual selection as dnd.ts's click branch.
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

  // A drag ends any lingering multi-selection, as on the timeline: the user
  // is now manipulating one item.
  if (state.hasMultiSelection()) state.clearSelection();

  // Unfold the parent an item was just nested into, so it doesn't vanish into
  // a folded block (dnd.ts does the same, for the same reason).
  const nestedInto = d.dropParentId;
  if (nestedInto !== null && nestedInto !== d.origParentId && state.isCollapsed(nestedInto)) {
    state.setCollapsed(nestedInto, false);
  }

  const patch: ItemPatch = {};
  if (d.dropParentId !== d.origParentId) patch.parentId = d.dropParentId;
  if (d.dropParentId === null && d.dropLaneId !== d.origLaneId) patch.laneId = d.dropLaneId;
  const containerChanged = d.dropParentId !== d.origParentId || d.dropLaneId !== d.origLaneId;
  if (d.dropRank !== null && (containerChanged || d.dropRank !== d.origIndex)) {
    patch.rank = d.dropRank;
  }
  if (Object.keys(patch).length > 0) {
    void actions.updateItem(d.id, patch);
  }
  // No net change needs no notify: unlike a bar resize, the preview never
  // touched the element's real geometry — resetVisuals clearing the transform
  // already put the row back exactly where the model has it.
}

function resetVisuals(d: WbsDrag): void {
  // `started` gates every preview mutation, so before it there is nothing to
  // reset (the dnd.ts rule).
  if (!d.started) return;
  d.el.classList.remove("dragging");
  d.el.style.pointerEvents = "";
  d.el.style.transform = "";
  clearHighlights();
}

function cancelDrag(): void {
  if (!drag) return;
  const d = drag;
  drag = null;
  dblClick.reset();
  resetVisuals(d);
}
