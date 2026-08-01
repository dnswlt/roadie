// Snapping math for chart drags, kept DOM-free so it can be tested directly
// (snap.test.ts). dnd.ts owns the pointer gestures and feeds these functions the
// numbers; nothing here touches the DOM, the state store, or the current scale.
//
// Everything works in the **boundary domain**, not in days. A bar covering days
// [start, end] occupies the pixel range [xOf(start), xOf(end + 1)), so its edges
// sit at `start` and `end + 1`. Snapping edges in that domain is what makes "A's
// end meets B's start" come out flush instead of overlapping by the shared day.
// Callers convert back with `end = boundary - 1` for a right edge.

import { nearestBoundary } from "./schedule";
import { snapToGrid, type SnapMode } from "./timescale";

// Magnetic snap radius in screen pixels, used only where there is no grid to
// snap to (see snapBoundary). Measured on screen, so it holds at any zoom.
export const SNAP_PX = 7;

// A day -> day function: where an edge falls once the coarse grid has its say.
export type Grid = (day: number) => number;

// The two primitives. Both answer "which target does this edge go to", and both
// are nearest-over-a-fixed-set, which is what keeps a drag monotonic: as the
// pointer moves steadily one way the result steps through the targets in order
// and never doubles back. They differ only in whether distance is a veto.

// nearestTarget: the closest target, however far away. Ties go to the earlier
// one (matching snapToGrid). `pos` itself when there are no targets.
function nearestTarget(pos: number, targets: number[]): number {
  let best = pos;
  let bestDist = Infinity;
  for (const t of targets) {
    const dist = Math.abs(t - pos);
    if (dist < bestDist || (dist === bestDist && t < best)) {
      best = t;
      bestDist = dist;
    }
  }
  return best;
}

// nearestWithin: the closest target inside SNAP_PX, or null when none is. Null
// rather than `pos` unchanged because an exact hit and a miss would otherwise be
// the same value: an edge resting precisely on a magnet has found it, and must
// not be handed on to something else that would pull it off again.
export function nearestWithin(pos: number, targets: number[], px: number): number | null {
  let best: number | null = null;
  let bestDist = SNAP_PX + 1;
  for (const t of targets) {
    const dist = Math.abs(t - pos) * px;
    if (dist <= SNAP_PX && dist < bestDist) {
      best = t;
      bestDist = dist;
    }
  }
  return best;
}

// gridSnapper resolves the coarse grid a dragged edge falls to, or null when
// there is no grid: "day" mode, or "schedule" mode on a roadmap with no
// schedule. (Alt is not handled here — it suppresses feature magnets too, so
// dnd.ts skips snapping altogether.) Null rather than the identity function
// because the callers branch on it; see snapBoundary.
export function gridSnapper(mode: SnapMode, bounds: number[]): Grid | null {
  if (mode === "day") return null;
  if (mode === "schedule") {
    return bounds.length === 0 ? null : (d) => nearestBoundary(d, bounds);
  }
  return (d) => snapToGrid(d, mode);
}

// snapBoundary resolves a single dragged/resized edge, given as a boundary
// position: it goes to the nearest target, which is the grid line or a feature
// boundary in `cands` (other items' edges, milestones, today).
//
// The radius applies only when there is no grid. There, free placement is the
// default and the radius decides whether to snap at all. With a grid that
// question is already settled — everything snaps somewhere — and a radius then
// does harm: it is a window centred on the feature, but the grid's answer inside
// that window can sit on the far side of it, so crossing in drags the bar
// backwards and hovering on the threshold oscillates. Distance alone gives the
// feature one contiguous stretch, and the drag stays monotonic.
export function snapBoundary(bound: number, cands: number[], px: number, grid: Grid | null): number {
  if (grid === null) return nearestWithin(bound, cands, px) ?? bound;
  return nearestTarget(bound, [grid(bound), ...cands]);
}

// moveBounds returns a bar's two edge boundaries after a rigid shift of
// `dayDelta`: the left edge sits at start, the right edge at end + 1.
export function moveBounds(startDay: number, endDay: number, dayDelta: number): [number, number] {
  return [startDay + dayDelta, endDay + 1 + dayDelta];
}

// moveTargets restates a move as a problem about one edge. The bar is rigid, so
// its end edge landing on a feature `c` is its start edge landing on `c - len`:
// both edges stay magnetic, but as one target list for the start edge. That is
// what lets a move use the same nearest-target rule as a resize.
function moveTargets(cands: number[], len: number): number[] {
  return [...cands, ...cands.map((c) => c - len)];
}

// snapMoveDelta resolves a move: same rule as snapBoundary, applied to the start
// edge over the targets above, and returned as a day-offset so the caller shifts
// the whole bar (duration is preserved by construction).
//
// The grid contributes a target for the start edge only. Letting the end edge
// chase grid lines too made the nearer of the two win, so the winner flipped
// mid-drag and the bar jumped by up to half a grid period. Features stay on both
// edges — they are what makes a bar close flush against its neighbour — and
// nearest-target keeps that monotonic.
export function snapMoveDelta(
  startDay: number,
  endDay: number,
  dayDelta: number,
  px: number,
  cands: number[],
  grid: Grid | null,
): number {
  const [startEdge, endEdge] = moveBounds(startDay, endDay, dayDelta);
  const targets = moveTargets(cands, endEdge - startEdge);
  const landed =
    grid === null
      ? (nearestWithin(startEdge, targets, px) ?? startEdge)
      : nearestTarget(startEdge, [grid(startEdge), ...targets]);
  return dayDelta + (landed - startEdge);
}
