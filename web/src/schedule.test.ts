import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  nearestBoundary,
  parseSchedule,
  periodAtEdge,
  periodDates,
  periodsByStart,
  scheduleBounds,
  serializeSchedule,
} from "./schedule";
import { dayOf } from "./timescale";
import type { SchedulePeriod } from "./types";

test("parseSchedule reads START END LABEL lines", () => {
  const { periods, errors } = parseSchedule(
    "2026-01-05 2026-01-16 Sprint 1\n2026-01-19 2026-01-30 PI 2026-Q1",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(periods, [
    { startDate: "2026-01-05", endDate: "2026-01-16", label: "Sprint 1" },
    { startDate: "2026-01-19", endDate: "2026-01-30", label: "PI 2026-Q1" },
  ]);
});

test("parseSchedule ignores blank and comment lines", () => {
  const { periods, errors } = parseSchedule(
    "# sprints\n\n  \n2026-01-05 2026-01-16 Sprint 1\n",
  );
  assert.deepEqual(errors, []);
  assert.equal(periods.length, 1);
});

test("parseSchedule collects per-line errors and keeps good lines", () => {
  const { periods, errors } = parseSchedule(
    [
      "garbage line",
      "2026-13-01 2026-01-16 Bad month",
      "2026-01-16 2026-01-05 End before start",
      "2026-02-02 2026-02-13 Good",
    ].join("\n"),
  );
  assert.equal(periods.length, 1);
  assert.equal(periods[0]!.label, "Good");
  assert.equal(errors.length, 3);
  assert.match(errors[0]!, /Line 1/);
  assert.match(errors[1]!, /Line 2/);
  assert.match(errors[2]!, /before start/);
});

test("serializeSchedule round-trips through parseSchedule (ordered by start)", () => {
  const stored: SchedulePeriod[] = [
    { id: 2, startDate: "2026-01-19", endDate: "2026-01-30", label: "Sprint 2" },
    { id: 1, startDate: "2026-01-05", endDate: "2026-01-16", label: "Sprint 1" },
  ];
  const text = serializeSchedule(stored);
  assert.equal(text.split("\n")[0], "2026-01-05 2026-01-16 Sprint 1");
  const { periods, errors } = parseSchedule(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    periods.map((p) => p.label),
    ["Sprint 1", "Sprint 2"],
  );
});

test("scheduleBounds yields start and end+1 per period, sorted & deduped", () => {
  // Two adjacent periods share a boundary (16+1 == 17), so it appears once.
  const periods: SchedulePeriod[] = [
    { id: 1, startDate: "2026-01-05", endDate: "2026-01-16", label: "A" },
    { id: 2, startDate: "2026-01-17", endDate: "2026-01-30", label: "B" },
  ];
  const bounds = scheduleBounds(periods);
  assert.deepEqual(bounds, [
    dayOf("2026-01-05"),
    dayOf("2026-01-17"),
    dayOf("2026-01-31"), // 2026-01-30 + 1
  ]);
});

test("nearestBoundary picks the closest, ties round down", () => {
  const bounds = [dayOf("2026-01-05"), dayOf("2026-01-17")];
  assert.equal(nearestBoundary(dayOf("2026-01-06"), bounds), dayOf("2026-01-05"));
  assert.equal(nearestBoundary(dayOf("2026-01-16"), bounds), dayOf("2026-01-17"));
  // Exact midpoint (2026-01-11 is 6 days from each) -> earlier boundary.
  assert.equal(nearestBoundary(dayOf("2026-01-11"), bounds), dayOf("2026-01-05"));
  assert.equal(nearestBoundary(42, []), 42); // no bounds -> unchanged
});

// Two adjacent periods, the shape a PI cadence has.
const PIS: SchedulePeriod[] = [
  { id: 2, startDate: "2026-03-02", endDate: "2026-04-24", label: "PI2026-03" },
  { id: 1, startDate: "2026-01-05", endDate: "2026-02-27", label: "PI2026-01" },
];

test("periodsByStart orders by start date", () => {
  assert.deepEqual(
    periodsByStart(PIS).map((p) => p.label),
    ["PI2026-01", "PI2026-03"],
  );
});

test("periodAtEdge matches an edge exactly, never a containing period", () => {
  assert.equal(periodAtEdge(PIS, "start", "2026-01-05")?.label, "PI2026-01");
  assert.equal(periodAtEdge(PIS, "end", "2026-02-27")?.label, "PI2026-01");
  assert.equal(periodAtEdge(PIS, "start", "2026-01-19"), null); // inside PI2026-01
  assert.equal(periodAtEdge(PIS, "end", "2026-03-02"), null); // a start, not an end
  assert.equal(periodAtEdge(PIS, "start", "2025-12-01"), null); // before the schedule
});

test("periodDates sets the chosen edge and leaves the other alone", () => {
  const item = { startDate: "2026-01-19", endDate: "2026-04-10" };
  assert.deepEqual(periodDates("start", PIS[1]!, item), {
    startDate: "2026-01-05",
    endDate: "2026-04-10",
  });
  assert.deepEqual(periodDates("end", PIS[0]!, item), {
    startDate: "2026-01-19",
    endDate: "2026-04-24",
  });
});

test("periodDates collapses onto the period rather than inverting the range", () => {
  // End currently sits before the newly chosen start period.
  assert.deepEqual(
    periodDates("start", PIS[0]!, { startDate: "2026-01-05", endDate: "2026-02-27" }),
    { startDate: "2026-03-02", endDate: "2026-04-24" },
  );
  // Start currently sits after the newly chosen end period.
  assert.deepEqual(
    periodDates("end", PIS[1]!, { startDate: "2026-03-02", endDate: "2026-04-24" }),
    { startDate: "2026-01-05", endDate: "2026-02-27" },
  );
  // Order still holds when the edges merely touch, so nothing collapses.
  assert.deepEqual(
    periodDates("start", PIS[0]!, { startDate: "2026-02-01", endDate: "2026-03-02" }),
    { startDate: "2026-03-02", endDate: "2026-03-02" },
  );
});
