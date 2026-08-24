import { strict as assert } from "node:assert";
import { test } from "node:test";
import { contentRange, dayOf, isoOf, quarterStart, snapToGrid, spanFraction, weekStart } from "./timescale";
import type { Item, ItemFull, LaneFull, Milestone } from "./types";

// Helper: snap an ISO date to a grid and read the result back as ISO.
function snapIso(iso: string, mode: Parameters<typeof snapToGrid>[1]): string {
  return isoOf(snapToGrid(dayOf(iso), mode));
}

// Minimal fixtures: contentRange only reads dates and nesting, so every other
// field gets a throwaway value.
function item(startDate: string, endDate: string, children: Item[] = []): ItemFull {
  return {
    id: 0,
    laneId: 0,
    parentId: null,
    title: "x",
    description: "",
    startDate,
    endDate,
    rank: 0,
    priority: null,
    labels: [],
    flagged: false,
    tentative: false,
    atRisk: false,
    children,
  };
}

function milestone(date: string): Milestone {
  return { id: 0, laneId: 0, title: "x", description: "", date, tentative: false };
}

function lane(items: ItemFull[], milestoneDates: string[] = []): LaneFull {
  return {
    id: 0,
    roadmapId: 0,
    name: "x",
    position: 0,
    color: "blue",
    items,
    milestones: milestoneDates.map(milestone),
  };
}

test("contentRange spans items, children and milestones across lanes", () => {
  const range = contentRange([
    lane([item("2024-03-01", "2024-03-10")], ["2024-06-15"]),
    lane([item("2024-02-01", "2024-02-05")]),
  ]);
  assert.ok(range);
  assert.equal(isoOf(range.startDay), "2024-02-01");
  assert.equal(isoOf(range.endDay), "2024-06-15");
});

test("contentRange includes children that escape their parent's span", () => {
  const range = contentRange([
    lane([item("2024-03-01", "2024-03-10", [item("2024-01-05", "2024-05-20")])]),
  ]);
  assert.ok(range);
  assert.equal(isoOf(range.startDay), "2024-01-05");
  assert.equal(isoOf(range.endDay), "2024-05-20");
});

test("contentRange returns null when there is nothing to frame", () => {
  assert.equal(contentRange([]), null);
  assert.equal(contentRange([lane([])]), null);
});

test("spanFraction measures in the boundary domain", () => {
  // A 10-day extent, so one day is exactly 0.1 wide.
  const extent = { startDay: dayOf("2024-01-01"), endDay: dayOf("2024-01-10") };
  const full = spanFraction(dayOf("2024-01-01"), dayOf("2024-01-10"), extent);
  assert.deepEqual(full, { left: 0, width: 1 }); // the extent itself fills it
  const first = spanFraction(dayOf("2024-01-01"), dayOf("2024-01-01"), extent);
  assert.deepEqual(first, { left: 0, width: 0.1 }); // one day has width
  const last = spanFraction(dayOf("2024-01-10"), dayOf("2024-01-10"), extent);
  assert.equal(last.left + last.width, 1); // and the last one reaches the end
  const mid = spanFraction(dayOf("2024-01-03"), dayOf("2024-01-07"), extent);
  assert.deepEqual(mid, { left: 0.2, width: 0.5 });
});

test("spanFraction handles a single-day extent", () => {
  const day = dayOf("2024-01-01");
  assert.deepEqual(spanFraction(day, day, { startDay: day, endDay: day }), { left: 0, width: 1 });
});

test("weekStart returns the Monday on or before the day", () => {
  assert.equal(isoOf(weekStart(dayOf("2024-01-01"))), "2024-01-01"); // Mon -> itself
  assert.equal(isoOf(weekStart(dayOf("2024-01-03"))), "2024-01-01"); // Wed
  assert.equal(isoOf(weekStart(dayOf("2024-01-07"))), "2024-01-01"); // Sun
  assert.equal(isoOf(weekStart(dayOf("2024-01-08"))), "2024-01-08"); // next Mon
  assert.equal(isoOf(weekStart(dayOf("1969-12-31"))), "1969-12-29"); // across the epoch
});

test("quarterStart returns Jan/Apr/Jul/Oct 1 of the containing quarter", () => {
  assert.equal(isoOf(quarterStart(dayOf("2024-02-15"))), "2024-01-01");
  assert.equal(isoOf(quarterStart(dayOf("2024-05-01"))), "2024-04-01");
  assert.equal(isoOf(quarterStart(dayOf("2024-12-31"))), "2024-10-01");
});

test("snapToGrid day mode is the identity", () => {
  assert.equal(snapIso("2024-03-14", "day"), "2024-03-14");
});

test("snapToGrid week rounds to the nearest Monday (ties go earlier)", () => {
  assert.equal(snapIso("2024-01-03", "week"), "2024-01-01"); // Wed -> back
  assert.equal(snapIso("2024-01-05", "week"), "2024-01-08"); // Fri -> forward
  assert.equal(snapIso("2024-01-04", "week"), "2024-01-01"); // Thu, tie -> earlier
});

test("snapToGrid month rounds to the nearest 1st", () => {
  assert.equal(snapIso("2024-01-10", "month"), "2024-01-01");
  assert.equal(snapIso("2024-01-20", "month"), "2024-02-01");
});

test("snapToGrid quarter rounds to the nearest quarter start", () => {
  assert.equal(snapIso("2024-02-15", "quarter"), "2024-01-01");
  assert.equal(snapIso("2024-03-01", "quarter"), "2024-04-01");
  assert.equal(snapIso("2024-11-20", "quarter"), "2025-01-01"); // rolls into next year
});
