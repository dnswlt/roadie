// Derives pixel positions for the items of a lane. Every top-level item
// gets its own row, stacked in the model's explicit order (rank); children
// likewise get one row each inside their parent's block. Nothing about
// vertical placement is stored — it is a pure function of the item order.

import { dayOf, xOf, type Scale } from "./timescale";
import type { Item, ItemFull, LaneFull } from "./types";

export const LABEL_W = 220;
export const PARENT_BAR_H = 30;
export const CHILD_H = 30;
export const CHILD_GAP = 0;
export const BLOCK_GAP = 8;
export const LANE_PAD = 10;
export const MIN_LANE_H = 56;

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

export function layoutLane(lane: LaneFull, scale: Scale): LaneLayout {
  let y = LANE_PAD;
  const blocks: PlacedBlock[] = lane.items.map((item) => {
    const span = spanOf(item, scale);
    const children: PlacedChild[] = item.children.map((c, i) => {
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
  return { blocks, height };
}
