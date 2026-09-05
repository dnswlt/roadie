// Derives pixel positions for the items of a lane. Every top-level item
// gets its own row, stacked in the model's explicit order (rank); children
// likewise get one row each inside their parent's block. Nothing about
// vertical placement is stored — it is a pure function of the item order.

import { dayOf, xOf, type Scale } from "./timescale";
import type { Item, ItemFull, LaneFull, Milestone } from "./types";

export const LABEL_W = 220;
export const PARENT_BAR_H = 30;
export const CHILD_H = 30;
export const CHILD_GAP = 0;
export const BLOCK_GAP = 8;
export const LANE_PAD = 10;
export const MIN_LANE_H = 56;
// Vertical strip reserved at the top of a lane for milestone diamonds; only
// present when the lane has milestones, and one MS_ROW_H taller for each extra
// row a cluster needs (see packMilestoneRows). Diamonds hang from the lane's
// top border, so this just keeps the first item clear of them.
export const MILESTONE_BAND = 16;
// Vertical pitch between milestone rows, tall enough that a row's label clears
// the next row's diamond.
export const MS_ROW_H = 20;

// Geometry of a milestone's band label, mirrored by .milestone-label in
// styles.css: the label's left edge sits MS_LABEL_LEFT px right of the
// diamond's center (the 13px diamond box plus a 6px gap, minus half the box).
// MS_LABEL_CLEAR is measured back from the next milestone's center; 14px
// clears the rotated diamond's roughly 9px half-width plus a small gap.
export const MS_LABEL_LEFT = 12.5;
export const MS_LABEL_CLEAR = 14;

// Milestone titles have no expanded state on the timeline, so this is primarily
// a readability limit, not a row-saving heuristic. 320px leaves ordinary long
// titles useful at a glance while still bounding pathological names. It covers
// the complete label, semantic marks included, and is shared by rendering and
// packing so their geometry stays exact.
export const MS_LABEL_MAX = 320;

export interface MilestoneRows {
  rowOf: Map<number, number>;
  rowCount: number;
}

// packMilestoneRows decides which band row each milestone's label prints on,
// so that no label is ever overlapped by the next diamond — the whole reason
// the band has rows at all.
//
// Standard interval packing: each milestone occupies its row from its own
// diamond across its label, and takes the first row already clear at that x,
// opening a new one only when every existing row is still busy. Rows therefore
// count how many milestones genuinely overlap at once, not how many exist —
// well-spread milestones share row 0 however many there are, and only a real
// pile-up grows the band.
//
// `labelWidth` is supplied by the caller (the renderer measures text) to keep
// this module free of the DOM, as `isCollapsed` keeps it free of view state.
export function packMilestoneRows(
  milestones: Milestone[],
  scale: Scale,
  labelWidth: (milestone: Milestone) => number,
): MilestoneRows {
  const rowEnds: number[] = []; // x at which each row becomes free again
  const rowOf = new Map<number, number>();
  for (const m of milestones) {
    const x = xOf(scale, dayOf(m.date));
    const right =
      x + MS_LABEL_LEFT + Math.min(labelWidth(m), MS_LABEL_MAX) + MS_LABEL_CLEAR;
    let row = rowEnds.findIndex((end) => end <= x);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(right);
    } else {
      rowEnds[row] = right;
    }
    rowOf.set(m.id, row);
  }
  return { rowOf, rowCount: rowEnds.length };
}

export interface PlacedChild {
  item: Item;
  x: number; // relative to the parent block
  y: number;
  w: number;
  h: number;
}

export interface PlacedBlock {
  item: ItemFull;
  x: number; // relative to the lane canvas
  y: number;
  w: number;
  h: number;
  children: PlacedChild[];
}

export interface LaneLayout {
  blocks: PlacedBlock[];
  milestoneRowOf: Map<number, number>;
  height: number;
}

interface Span {
  start: number;
  end: number; // px, exclusive
}

function spanOf(item: Item, scale: Scale): Span {
  const start = xOf(scale, dayOf(item.startDate));
  // +1: the end date is inclusive, the bar covers the whole end day.
  const end = xOf(scale, dayOf(item.endDate) + 1);
  return { start, end: Math.max(end, start + 2) };
}

export function blockHeight(numChildren: number): number {
  return numChildren === 0
    ? PARENT_BAR_H
    : PARENT_BAR_H + CHILD_GAP + numChildren * (CHILD_H + CHILD_GAP);
}

// layoutLane places a lane's items. `labelWidth` measures a milestone label,
// which decides how many band rows the milestones need and so where the first
// item starts; it has no default because a wrong width silently overlaps
// labels, unlike `isCollapsed`, whose default of "nothing folded" is simply
// true of a lane with no fold state. Both are passed in rather than read from
// state or the DOM, to keep this module free of view state.
export function layoutLane(
  lane: LaneFull,
  scale: Scale,
  labelWidth: (milestone: Milestone) => number,
  isCollapsed: (itemId: number) => boolean = () => false,
): LaneLayout {
  const { rowOf: milestoneRowOf, rowCount } = packMilestoneRows(
    lane.milestones,
    scale,
    labelWidth,
  );
  let y = LANE_PAD + (rowCount === 0 ? 0 : MILESTONE_BAND + (rowCount - 1) * MS_ROW_H);
  const blocks: PlacedBlock[] = lane.items.map((item) => {
    const span = spanOf(item, scale);
    const kids = isCollapsed(item.id) ? [] : item.children;
    const children: PlacedChild[] = kids.map((c, i) => {
      const cs = spanOf(c, scale);
      return {
        item: c,
        x: cs.start - span.start,
        y: PARENT_BAR_H + CHILD_GAP + i * (CHILD_H + CHILD_GAP),
        w: cs.end - cs.start,
        h: CHILD_H,
      };
    });
    const h = blockHeight(children.length);
    const block: PlacedBlock = { item, x: span.start, y, w: span.end - span.start, h, children };
    y += h + BLOCK_GAP;
    return block;
  });
  const height = Math.max(MIN_LANE_H, y - BLOCK_GAP + LANE_PAD);
  return { blocks, milestoneRowOf, height };
}
