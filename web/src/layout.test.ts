import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  LANE_PAD,
  layoutLane,
  MILESTONE_BAND,
  MS_LABEL_CLEAR,
  MS_LABEL_LEFT,
  MS_LABEL_MAX,
  MS_ROW_H,
  packMilestoneRows,
} from "./layout";
import { isoOf, type Scale } from "./timescale";
import type { ItemFull, LaneFull, Milestone } from "./types";

// pxPerDay 1, startDay 0: a milestone's on-screen x equals its day offset, so
// dates below can be read directly as pixels.
const scale: Scale = { startDay: 0, endDay: 365, pxPerDay: 1 };

// A stand-in for the renderer's canvas measurement: every title is 100px wide,
// which with the label offset and clearance makes a milestone occupy roughly
// 125px of its row.
const width100 = (_milestone: Milestone) => 100;

function ms(id: number, day: number): Milestone {
  return { id, laneId: 1, title: `m${id}`, description: "", date: isoOf(day), tentative: false };
}

function item(id: number, day: number): ItemFull {
  return {
    id,
    laneId: 1,
    parentId: null,
    title: `i${id}`,
    description: "",
    startDate: isoOf(day),
    endDate: isoOf(day + 1),
    rank: 0,
    priority: null,
    labels: [],
    flagged: false,
    tentative: false,
    atRisk: false,
    children: [],
  };
}

function lane(milestones: Milestone[], items: ItemFull[] = []): LaneFull {
  return { id: 1, roadmapId: 1, name: "L", position: 0, color: "blue", items, milestones };
}

function rows(milestones: Milestone[], labelWidth = width100): number[] {
  const { rowOf } = packMilestoneRows(milestones, scale, labelWidth);
  return milestones.map((m) => rowOf.get(m.id)!);
}

test("milestones spaced wider than their labels all share row 0", () => {
  const spread = [ms(1, 0), ms(2, 200), ms(3, 400), ms(4, 600)];
  assert.deepEqual(rows(spread), [0, 0, 0, 0]);
  assert.equal(packMilestoneRows(spread, scale, width100).rowCount, 1);
});

test("a milestone whose label would be overlapped moves to the next row", () => {
  assert.deepEqual(rows([ms(1, 0), ms(2, 10)]), [0, 1]);
});

test("a dependency mark's measured width widens that milestone's interval", () => {
  // The renderer's callback includes the mark in milestone 1's label width.
  const wide = (m: Milestone) => (m.id === 1 ? 250 : 40);
  assert.deepEqual(rows([ms(1, 0), ms(2, 200)], wide), [0, 1]);
});

test("a label reuses the row once its center-relative clearance fits", () => {
  // 12.5px label offset + 100px title + 14px clearance = 126.5px.
  // The second milestone at 127px therefore fits, without subtracting the
  // diamond half-width a second time.
  assert.deepEqual(rows([ms(1, 0), ms(2, 127)]), [0, 0]);
});

// A row is never reused while its occupant's label is still running, however
// many rows that costs — the collision the band exists to prevent.
test("a third milestone in one cluster opens a third row rather than reusing a busy one", () => {
  assert.deepEqual(rows([ms(1, 0), ms(2, 10), ms(3, 20)]), [0, 1, 2]);
});

// Rows are reclaimed as soon as their occupant's label has ended, so a cluster
// costs rows only while it lasts.
test("a row is reused once its previous label has ended", () => {
  assert.deepEqual(rows([ms(1, 0), ms(2, 10), ms(3, 200)]), [0, 1, 0]);
});

// Row count tracks how many milestones overlap at once, not how many exist —
// the whole reason a long list of milestones need not cost a tall band.
test("row count follows peak overlap, not milestone count", () => {
  const many = [0, 200, 400, 600, 800, 1000, 1200, 1400].map((d, i) => ms(i + 1, d));
  assert.equal(packMilestoneRows(many, scale, width100).rowCount, 1);
});

// A verbose title ellipsizes rather than claiming a row of its own and pushing
// its neighbours down (MS_LABEL_MAX).
test("an over-long label is capped so it cannot push neighbours onto new rows", () => {
  const next = Math.ceil(MS_LABEL_LEFT + MS_LABEL_MAX + MS_LABEL_CLEAR);
  assert.deepEqual(rows([ms(1, 0), ms(2, next)], () => 10_000), [0, 0]);
});

test("no milestones assigns no rows", () => {
  const { rowOf, rowCount } = packMilestoneRows([], scale, width100);
  assert.equal(rowOf.size, 0);
  assert.equal(rowCount, 0);
});

test("a lane with no milestones reserves no band", () => {
  const { blocks } = layoutLane(lane([], [item(10, 0)]), scale, width100);
  assert.equal(blocks[0]!.y, LANE_PAD);
});

test("a single-row band leaves the first item just below it", () => {
  const l = lane([ms(1, 0), ms(2, 300)], [item(10, 0)]);
  const { blocks } = layoutLane(l, scale, width100);
  assert.equal(blocks[0]!.y, LANE_PAD + MILESTONE_BAND);
});

// Each extra row a cluster needs pushes the lane's items down by exactly one
// row pitch, so the band never overlaps the first bar.
test("the band grows by one row pitch for each extra row a cluster needs", () => {
  const two = lane([ms(1, 0), ms(2, 10)], [item(10, 0)]);
  assert.equal(
    layoutLane(two, scale, width100).blocks[0]!.y,
    LANE_PAD + MILESTONE_BAND + MS_ROW_H,
  );

  const three = lane([ms(1, 0), ms(2, 10), ms(3, 20)], [item(10, 0)]);
  assert.equal(
    layoutLane(three, scale, width100).blocks[0]!.y,
    LANE_PAD + MILESTONE_BAND + 2 * MS_ROW_H,
  );
});
