import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  gridSnapper,
  moveBounds,
  snapBoundary,
  snapEdge,
  snapMoveDelta,
  snapMoveToFeatures,
  SNAP_PX,
} from "./snap";
import { dayOf } from "./timescale";

const PX = 10; // pixels per day: SNAP_PX(7) is well under one day, so radii are sub-day
const IDENTITY = (d: number): number => d;

test("snapEdge takes the nearest candidate inside the radius", () => {
  // At 10 px/day the radius is 0.7 days, so only an exact hit qualifies.
  assert.equal(snapEdge(10, [10, 20], PX), 10);
  assert.equal(snapEdge(11, [10, 20], PX), null); // 1 day = 10px > SNAP_PX
  // Zoomed out to 3 px/day, 2 days is 6px and does qualify.
  assert.equal(snapEdge(12, [10, 20], 3), 10);
  // Nearest wins when several are in range.
  assert.equal(snapEdge(12, [10, 13, 20], 3), 13);
  assert.equal(snapEdge(42, [], PX), null);
});

test("snapEdge measures the radius in pixels, not days", () => {
  const day = 100;
  const cands = [105]; // 5 days away
  assert.equal(snapEdge(day, cands, 1), 105); // 5px -> in range
  assert.equal(snapEdge(day, cands, 2), null); // 10px -> out of range
  assert.equal(SNAP_PX, 7);
});

test("snapEdge reports an exact hit, not a miss", () => {
  // The distinction the null return exists for: landing precisely on a feature
  // must not look like "nothing found", or the grid pulls the edge back off it.
  assert.equal(snapEdge(10, [10], PX), 10);
});

test("moveBounds puts the right edge at end + 1", () => {
  // A one-day item on day 5 owns [5, 6): the two edges are 5 and 6, not 5 and 5.
  assert.deepEqual(moveBounds(5, 5, 0), [5, 6]);
  assert.deepEqual(moveBounds(5, 9, 3), [8, 13]);
});

test("gridSnapper: day mode and bypass are the identity", () => {
  assert.equal(gridSnapper(false, "day", [])(12345), 12345);
  assert.equal(gridSnapper(true, "quarter", [])(12345), 12345);
});

test("gridSnapper: schedule mode degrades to free placement with no periods", () => {
  const bounds = [dayOf("2026-01-05"), dayOf("2026-01-19")];
  assert.equal(gridSnapper(false, "schedule", bounds)(dayOf("2026-01-07")), dayOf("2026-01-05"));
  // No schedule defined -> the mode must not silently fall back to a calendar grid.
  const day = dayOf("2026-01-07");
  assert.equal(gridSnapper(false, "schedule", [])(day), day);
});

test("snapBoundary prefers a feature over the grid", () => {
  const grid = gridSnapper(false, "month", []);
  const feature = dayOf("2026-02-10");
  // Off-grid feature within reach: it wins over the month line.
  assert.equal(snapBoundary(feature + 1, [feature], 3, grid), feature);
  // Nothing near: fall to the month grid.
  assert.equal(snapBoundary(dayOf("2026-02-10"), [], PX, grid), dayOf("2026-02-01"));
});

test("an edge resting exactly on a feature stays there", () => {
  // The grid must not get a second say once a feature has been matched —
  // otherwise dragging across an off-grid neighbour flickers between the two.
  const grid = gridSnapper(false, "month", []);
  const feature = dayOf("2026-02-10"); // deliberately not on a month line
  assert.equal(snapBoundary(feature, [feature], PX, grid), feature);
});

test("snapMoveToFeatures aligns whichever edge is closest, keeping duration", () => {
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19"); // 10 days, right edge at 03-20
  const neighbourStart = dayOf("2026-03-25");
  // Drag right so the *end* edge lands one day short of the neighbour's start:
  // the end edge is the magnet here, and the bar closes flush.
  const dd = neighbourStart - dayOf("2026-03-20") - 1;
  const md = snapMoveToFeatures(start, end, dd, 3, [neighbourStart]);
  assert.notEqual(md, null);
  assert.equal(end + md! + 1, neighbourStart); // end + 1 == neighbour's start: flush, no overlap
  assert.equal(end + md! - (start + md!), end - start); // duration preserved
});

test("snapMoveToFeatures reports a miss as null, an exact alignment as a hit", () => {
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19");
  assert.equal(snapMoveToFeatures(start, end, 4, PX, []), null); // Shift / grid-only
  assert.equal(snapMoveToFeatures(start, end, 4, PX, [dayOf("2026-06-01")]), null); // far away
  // Already perfectly aligned: a hit that happens to need no correction, which
  // must not be reported as "nothing found".
  assert.equal(snapMoveToFeatures(start, end, 4, PX, [start + 4]), 4);
});

// The regression this module was extracted to pin. A move grid-snaps its START
// edge only; letting both edges compete made the winner flip mid-drag, so a
// one-day pointer movement could teleport the bar half a grid period. See the
// comment on snapMoveDelta.
test("a move grid-snaps the start edge, never the end", () => {
  const grid = gridSnapper(false, "month", []);
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19"); // 10 days: NOT a whole number of months
  for (let dd = 0; dd <= 60; dd++) {
    const md = snapMoveDelta(start, end, dd, PX, [], grid);
    const s = start + md;
    assert.equal(s, grid(s), `drag ${dd}: start ${s} is not on a month boundary`);
  }
});

test("a move never jumps backwards as the drag goes forwards", () => {
  const grid = gridSnapper(false, "quarter", []);
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19");
  let prev = -Infinity;
  for (let dd = 0; dd <= 200; dd++) {
    const s = start + snapMoveDelta(start, end, dd, PX, [], grid);
    assert.ok(s >= prev, `drag ${dd}: start went backwards, ${prev} -> ${s}`);
    prev = s;
  }
});

test("a move never leaps more than one grid step at a time", () => {
  // Under the old two-edge rule a single day of drag could move the bar by half
  // a grid period; now each step is at most one whole month.
  const grid = gridSnapper(false, "month", []);
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19");
  let prev = start + snapMoveDelta(start, end, 0, PX, [], grid);
  for (let dd = 1; dd <= 200; dd++) {
    const s = start + snapMoveDelta(start, end, dd, PX, [], grid);
    assert.ok(s - prev <= 31, `drag ${dd}: jumped ${s - prev} days in one step`);
    prev = s;
  }
});

test("a move preserves duration whatever the grid does", () => {
  const grid = gridSnapper(false, "quarter", []);
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19");
  for (let dd = -50; dd <= 50; dd++) {
    const md = snapMoveDelta(start, end, dd, PX, [dayOf("2026-04-02")], grid);
    assert.equal(end + md - (start + md), end - start);
  }
});

test("feature magnets beat the grid on a move", () => {
  const grid = gridSnapper(false, "month", []);
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19");
  // A milestone one day past where the start edge lands: close enough to grab it,
  // and it must win over the far-off month line.
  const milestone = start + 5;
  const md = snapMoveDelta(start, end, 4, 3, [milestone], grid);
  assert.equal(start + md, milestone);
});

test("a move resting exactly on a feature is not handed to the grid", () => {
  // The move-side twin of "an edge resting exactly on a feature stays there".
  const grid = gridSnapper(false, "month", []);
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19");
  const dd = 4;
  const milestone = start + dd; // the start edge already lands on it
  assert.equal(snapMoveDelta(start, end, dd, PX, [milestone], grid), dd);
});

test("day mode plus no features is free, day-by-day movement", () => {
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19");
  for (const dd of [-7, -1, 0, 1, 3, 11]) {
    assert.equal(snapMoveDelta(start, end, dd, PX, [], IDENTITY), dd);
  }
});
