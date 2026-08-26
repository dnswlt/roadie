import assert from "node:assert/strict";
import test from "node:test";

import { resolveExtractedRange } from "./schedule-check";
import type { SchedulePeriod } from "./types";

const periods: SchedulePeriod[] = [
  { id: 1, label: "PI2026-09", startDate: "2026-09-01", endDate: "2026-09-30" },
  { id: 2, label: "PI2026-10", startDate: "2026-10-01", endDate: "2026-10-31" },
];

test("period references supply their respective boundaries", () => {
  assert.deepEqual(
    resolveExtractedRange(
      { startPeriod: "PI2026-09", endPeriod: "PI2026-10" },
      periods,
    ),
    { start: "2026-09-01", end: "2026-10-31" },
  );
});

test("literal and period boundaries can be mixed", () => {
  assert.deepEqual(
    resolveExtractedRange(
      { start: "2026-09-12", endPeriod: "PI2026-09" },
      periods,
    ),
    { start: "2026-09-12", end: "2026-09-30" },
  );
});

test("a period reference needs a roadmap schedule", () => {
  assert.deepEqual(resolveExtractedRange({ startPeriod: "PI2026-09" }, []), {
    error: "Roadmap has no schedule",
  });
});

test("period labels match exactly", () => {
  assert.deepEqual(
    resolveExtractedRange({ endPeriod: "pi2026-09" }, periods),
    { error: 'Schedule period "pi2026-09" not found' },
  );
});

test("literal ranges do not need a schedule", () => {
  assert.deepEqual(
    resolveExtractedRange({ start: "2026-09-01", end: "2026-09-30" }, []),
    { start: "2026-09-01", end: "2026-09-30" },
  );
});
