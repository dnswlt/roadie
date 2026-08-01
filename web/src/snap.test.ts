import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  gridSnapper,
  moveBounds,
  snapBoundary,
  nearestWithin,
  snapMoveDelta,
  SNAP_PX,
} from "./snap";
import { dayOf } from "./timescale";

const PX = 10; // pixels per day: SNAP_PX(7) is well under one day, so radii are sub-day

test("nearestWithin takes the nearest candidate inside the radius", () => {
  // At 10 px/day the radius is 0.7 days, so only an exact hit qualifies.
  assert.equal(nearestWithin(10, [10, 20], PX), 10);
  assert.equal(nearestWithin(11, [10, 20], PX), null); // 1 day = 10px > SNAP_PX
  // Zoomed out to 3 px/day, 2 days is 6px and does qualify.
  assert.equal(nearestWithin(12, [10, 20], 3), 10);
  // Nearest wins when several are in range.
  assert.equal(nearestWithin(12, [10, 13, 20], 3), 13);
  assert.equal(nearestWithin(42, [], PX), null);
});

test("nearestWithin measures the radius in pixels, not days", () => {
  const day = 100;
  const cands = [105]; // 5 days away
  assert.equal(nearestWithin(day, cands, 1), 105); // 5px -> in range
  assert.equal(nearestWithin(day, cands, 2), null); // 10px -> out of range
  assert.equal(SNAP_PX, 7);
});

test("nearestWithin reports an exact hit, not a miss", () => {
  // The distinction the null return exists for: landing precisely on a feature
  // must not look like "nothing found", or the grid pulls the edge back off it.
  assert.equal(nearestWithin(10, [10], PX), 10);
});

test("moveBounds puts the right edge at end + 1", () => {
  // A one-day item on day 5 owns [5, 6): the two edges are 5 and 6, not 5 and 5.
  assert.deepEqual(moveBounds(5, 5, 0), [5, 6]);
  assert.deepEqual(moveBounds(5, 9, 3), [8, 13]);
});

test("gridSnapper: day mode means no grid at all", () => {
  assert.equal(gridSnapper("day", []), null);
  assert.notEqual(gridSnapper("quarter", []), null);
});

test("gridSnapper: schedule mode degrades to no grid with no periods", () => {
  const bounds = [dayOf("2026-01-05"), dayOf("2026-01-19")];
  const grid = gridSnapper("schedule", bounds);
  assert.equal(grid?.(dayOf("2026-01-07")), dayOf("2026-01-05"));
  // No schedule defined -> the mode must not silently fall back to a calendar grid.
  assert.equal(gridSnapper("schedule", []), null);
});

test("snapBoundary prefers a feature over the grid", () => {
  const grid = gridSnapper("month", []);
  const feature = dayOf("2026-02-10");
  // Off-grid feature within reach: it wins over the month line.
  assert.equal(snapBoundary(feature + 1, [feature], 3, grid), feature);
  // Nothing near: fall to the month grid.
  assert.equal(snapBoundary(dayOf("2026-02-10"), [], PX, grid), dayOf("2026-02-01"));
});

test("an edge resting exactly on a feature stays there", () => {
  // The grid must not get a second say once a feature has been matched —
  // otherwise dragging across an off-grid neighbour flickers between the two.
  const grid = gridSnapper("month", []);
  const feature = dayOf("2026-02-10"); // deliberately not on a month line
  assert.equal(snapBoundary(feature, [feature], PX, grid), feature);
});

test("a move with no grid closes flush against a neighbour", () => {
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19"); // 10 days, right edge at 03-20
  const neighbourStart = dayOf("2026-03-25");
  // Drag right so the *end* edge lands one day short of the neighbour's start:
  // the end edge is the magnet here, expressed as a start-edge target.
  const dd = neighbourStart - dayOf("2026-03-20") - 1;
  const md = snapMoveDelta(start, end, dd, 3, [neighbourStart], null);
  assert.equal(end + md + 1, neighbourStart); // end + 1 == neighbour's start: flush, no overlap
  assert.equal(end + md - (start + md), end - start); // duration preserved
});

test("a move with no grid stays put when nothing is in range", () => {
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19");
  assert.equal(snapMoveDelta(start, end, 4, PX, [], null), 4); // no features at all
  assert.equal(snapMoveDelta(start, end, 4, PX, [dayOf("2026-06-01")], null), 4); // far away
  // Already perfectly aligned: a hit that needs no correction, which must not be
  // mistaken for "nothing found".
  assert.equal(snapMoveDelta(start, end, 4, PX, [start + 4], null), 4);
});

// The regression this module was extracted to pin. A move grid-snaps its START
// edge only; letting both edges compete made the winner flip mid-drag, so a
// one-day pointer movement could teleport the bar half a grid period. See the
// comment on snapMoveDelta.
test("a move grid-snaps the start edge, never the end", () => {
  const grid = gridSnapper("month", []);
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19"); // 10 days: NOT a whole number of months
  for (let dd = 0; dd <= 60; dd++) {
    const md = snapMoveDelta(start, end, dd, PX, [], grid);
    const s = start + md;
    assert.equal(s, grid!(s), `drag ${dd}: start ${s} is not on a month boundary`);
  }
});

test("a move never jumps backwards as the drag goes forwards", () => {
  const grid = gridSnapper("quarter", []);
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19");
  let prev = -Infinity;
  for (let dd = 0; dd <= 200; dd++) {
    const s = start + snapMoveDelta(start, end, dd, PX, [], grid);
    assert.ok(s >= prev, `drag ${dd}: start went backwards, ${prev} -> ${s}`);
    prev = s;
  }
});

test("a move never jumps backwards with a feature in play", () => {
  // The wiggle case: a neighbour's edge sitting between two month lines.
  const grid = gridSnapper("month", []);
  const start = dayOf("2026-04-10");
  const end = dayOf("2026-04-19");
  const neighbour = dayOf("2026-04-27");
  let prev = -Infinity;
  for (let dd = 0; dd <= 40; dd++) {
    const s = start + snapMoveDelta(start, end, dd, 3, [neighbour], grid);
    assert.ok(s >= prev, `drag ${dd}: start went backwards, ${prev} -> ${s}`);
    prev = s;
  }
});

test("a move never leaps more than one grid step at a time", () => {
  // Under the old two-edge rule a single day of drag could move the bar by half
  // a grid period; now each step is at most one whole month.
  const grid = gridSnapper("month", []);
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
  const grid = gridSnapper("quarter", []);
  const start = dayOf("2026-03-10");
  const end = dayOf("2026-03-19");
  for (let dd = -50; dd <= 50; dd++) {
    const md = snapMoveDelta(start, end, dd, PX, [dayOf("2026-04-02")], grid);
    assert.equal(end + md - (start + md), end - start);
  }
});

test("feature magnets beat the grid on a move", () => {
  const grid = gridSnapper("month", []);
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
  const grid = gridSnapper("month", []);
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
    assert.equal(snapMoveDelta(start, end, dd, PX, [], null), dd);
    assert.equal(snapBoundary(start + dd, [], PX, null), start + dd);
  }
});

// The regression the user hit: with a coarse grid on, a neighbour's edge lying
// between two grid lines used to be reachable only inside a pixel-wide catchment,
// and the grid's answer inside that catchment sat on the far side of the feature.
// Dragging steadily forwards therefore lurched backwards on the way in.
test("a coarse grid and a feature never fight over the same stretch", () => {
  const grid = gridSnapper("month", []);
  const start = dayOf("2027-04-05");
  const end = dayOf("2027-05-02");
  const neighbour = dayOf("2027-04-27");
  const seen = new Set<number>();
  let prev = -Infinity;
  for (let dd = -60; dd <= 60; dd++) {
    const s = start + snapMoveDelta(start, end, dd, 0.4, [neighbour], grid);
    assert.ok(s >= prev, `drag ${dd}: start went backwards, ${prev} -> ${s}`);
    prev = s;
    seen.add(s);
  }
  // Zoomed far out (0.4 px/day, where the old radius spanned ~17 days) the
  // feature must still be reachable, not swamped by the month lines.
  assert.ok(seen.has(neighbour), "the neighbour's edge is never reachable");
});
