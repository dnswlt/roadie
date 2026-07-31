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

// Magnetic snap radius in screen pixels: a dragged edge snaps to a nearby item
// edge (or milestone, or today) when within this distance. Small enough to keep
// fine control; dnd.ts bypasses it entirely on Alt.
export const SNAP_PX = 7;

// A day -> day function: where an edge falls once the coarse grid has its say.
export type Grid = (day: number) => number;

// snapEdge returns the candidate day nearest `day` within SNAP_PX pixels, or
// null when nothing is close enough. `px` is pixels per day, so the radius stays
// constant on screen at any zoom.
//
// The miss is null rather than `day` unchanged because an exact hit and a miss
// would otherwise be the same value, and the caller has to tell them apart: an
// edge resting precisely on a neighbour has found its magnet, and must not be
// handed on to the grid to be pulled off again.
export function snapEdge(day: number, cands: number[], px: number): number | null {
  let best: number | null = null;
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

// gridSnapper resolves the coarse grid a dragged edge falls to when no item edge
// is close. `bypass` (Alt) disables the grid; the "schedule" mode snaps to the
// roadmap's schedule-period boundaries in `bounds`, degrading to free placement
// when it has none; every other mode uses its calendar grid.
export function gridSnapper(bypass: boolean, mode: SnapMode, bounds: number[]): Grid {
  if (bypass) return (d) => d;
  if (mode === "schedule") {
    return bounds.length === 0 ? (d) => d : (d) => nearestBoundary(d, bounds);
  }
  return (d) => snapToGrid(d, mode);
}

// snapBoundary resolves a single dragged/resized edge, given as a boundary
// position. Feature snapping (radius-limited) takes priority — aligning to a real
// item is the strongest intent — and only when no feature boundary is close does
// the edge fall to the `grid`. With the identity grid ("day" mode / Alt) this is
// pure feature snapping.
export function snapBoundary(bound: number, cands: number[], px: number, grid: Grid): number {
  return snapEdge(bound, cands, px) ?? grid(bound);
}

// moveBounds returns a bar's two edge boundaries after a rigid shift of
// `dayDelta`: the left edge sits at start, the right edge at end + 1.
export function moveBounds(startDay: number, endDay: number, dayDelta: number): [number, number] {
  return [startDay + dayDelta, endDay + 1 + dayDelta];
}

// snapMoveToFeatures adjusts a move's day-offset so that whichever of the two
// (rigidly shifted) edge boundaries is closest to a feature boundary in `cands`
// lands exactly on it, within SNAP_PX. Returns null when nothing is close enough
// (including when `cands` is empty — Shift/grid-only), which is distinct from
// returning `dayDelta`: an offset that already aligns an edge perfectly is a hit,
// and the grid must not get a second say. See snapEdge.
export function snapMoveToFeatures(
  startDay: number,
  endDay: number,
  dayDelta: number,
  px: number,
  cands: number[],
): number | null {
  let best: number | null = null;
  let bestDist = SNAP_PX + 1;
  for (const edge of moveBounds(startDay, endDay, dayDelta)) {
    for (const c of cands) {
      const dist = Math.abs(edge - c) * px;
      if (dist <= SNAP_PX && dist < bestDist) {
        bestDist = dist;
        best = dayDelta + (c - edge);
      }
    }
  }
  return best;
}

// snapMoveDelta resolves a move. Feature snapping (to a boundary in `cands`) wins
// when either edge boundary is within SNAP_PX of one; otherwise the offset is
// nudged so the *start* edge lands on a `grid` line, duration preserved. The move
// rides the grid but "clicks" onto neighbours. With empty `cands` (Shift) it is
// pure grid snapping; with an identity grid ("day" mode) it is pure feature
// snapping; with both, free per-day movement.
//
// Only the start edge competes for the grid, and the asymmetry is deliberate.
// Feature snapping is radius-limited, so letting both edges compete costs at most
// a SNAP_PX correction. Grid snapping has no radius — it always fires — so two
// competing edges are two unbounded attractors half a grid period apart: the
// winner flips mid-drag and the bar teleports by up to half a grid step (~45 days
// on Quarter), silently changing which edge is aligned. Concretely, with a 10-day
// item on a month grid, dragging 11 days right used to jump it 20 days and leave
// its *end*, not its start, on the boundary. Aligning an end is still possible —
// to a neighbour's edge, a milestone, or today, which are feature magnets and
// keep both edges live — just not to a bare grid line. See snap.test.ts, which
// pins the monotonicity this buys.
export function snapMoveDelta(
  startDay: number,
  endDay: number,
  dayDelta: number,
  px: number,
  cands: number[],
  grid: Grid,
): number {
  const feature = snapMoveToFeatures(startDay, endDay, dayDelta, px, cands);
  if (feature !== null) return feature;
  const [startEdge] = moveBounds(startDay, endDay, dayDelta);
  return dayDelta + (grid(startEdge) - startEdge);
}
