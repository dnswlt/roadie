import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dayOf, isoOf, quarterStart, snapToGrid, weekStart } from "./timescale";

// Helper: snap an ISO date to a grid and read the result back as ISO.
function snapIso(iso: string, mode: Parameters<typeof snapToGrid>[1]): string {
  return isoOf(snapToGrid(dayOf(iso), mode));
}

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
