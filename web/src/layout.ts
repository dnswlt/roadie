// Derives pixel positions for the items of a lane. Vertical placement is
// pure view logic: overlapping blocks are packed into tracks greedily,
// nothing is persisted.

import { dayOf, xOf, type Scale } from "./timescale";
import type { Item, ItemFull, LaneFull } from "./types";

export const LABEL_W = 220;
export const PARENT_BAR_H = 30;
export const CHILD_H = 24;
export const CHILD_GAP = 4;
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

// packTracks assigns each span (sorted by start) the first track whose last
// occupant ends at least `gap` pixels before it starts.
function packTracks(spans: Span[], gap: number): number[] {
  const trackEnds: number[] = [];
  return spans.map((s) => {
    for (let t = 0; t < trackEnds.length; t++) {
      if ((trackEnds[t] ?? 0) + gap <= s.start) {
        trackEnds[t] = s.end;
        return t;
      }
    }
    trackEnds.push(s.end);
    return trackEnds.length - 1;
  });
}

function spanOf(item: Item, scale: Scale): Span {
  const start = xOf(scale, dayOf(item.startDate));
  // +1: the end date is inclusive, the bar covers the whole end day.
  const end = xOf(scale, dayOf(item.endDate) + 1);
  return { start, end: Math.max(end, start + 2) };
}

export function layoutLane(lane: LaneFull, scale: Scale): LaneLayout {
  const blocks: PlacedBlock[] = lane.items.map((item) => {
    const span = spanOf(item, scale);
    const childSpans = item.children.map((c) => spanOf(c, scale));
    const childTracks = packTracks(childSpans, 4);
    const numTracks = childTracks.length === 0 ? 0 : Math.max(...childTracks) + 1;
    const children: PlacedChild[] = item.children.map((c, i) => {
      const cs = childSpans[i]!;
      return {
        item: c,
        x: cs.start - span.start,
        y: PARENT_BAR_H + CHILD_GAP + (childTracks[i] ?? 0) * (CHILD_H + CHILD_GAP),
        w: cs.end - cs.start,
        h: CHILD_H,
      };
    });
    const h = numTracks === 0 ? PARENT_BAR_H : PARENT_BAR_H + CHILD_GAP + numTracks * (CHILD_H + CHILD_GAP);
    return { item, x: span.start, y: 0, w: span.end - span.start, h, children };
  });

  // Pack blocks into tracks; a track is as tall as its tallest block.
  const trackOf = packTracks(
    blocks.map((b) => ({ start: b.x, end: b.x + b.w })),
    6,
  );
  const numTracks = trackOf.length === 0 ? 0 : Math.max(...trackOf) + 1;
  const trackHeights: number[] = new Array<number>(numTracks).fill(0);
  blocks.forEach((b, i) => {
    const t = trackOf[i] ?? 0;
    trackHeights[t] = Math.max(trackHeights[t] ?? 0, b.h);
  });
  const trackYs: number[] = [];
  let y = LANE_PAD;
  for (const h of trackHeights) {
    trackYs.push(y);
    y += h + BLOCK_GAP;
  }
  blocks.forEach((b, i) => {
    b.y = trackYs[trackOf[i] ?? 0] ?? LANE_PAD;
  });
  const height = Math.max(MIN_LANE_H, y - BLOCK_GAP + LANE_PAD);
  return { blocks, height };
}
