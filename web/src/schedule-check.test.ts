import assert from "node:assert/strict";
import test from "node:test";

import {
  projectScheduleCheck,
  reportScheduleCheck,
  resolveExtractedRange,
  scheduleCheckKeys,
} from "./schedule-check";
import type { ScheduleCheckItem } from "./recon-diff";
import type { SchedulePeriod, TrackerScheduleResult } from "./types";

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

test("resolved ranges cannot run backwards", () => {
  assert.deepEqual(
    resolveExtractedRange(
      { start: "2026-10-01", end: "2026-09-30" },
      periods,
    ),
    { error: "Issue range starts after it ends (2026-10-01 > 2026-09-30)" },
  );
  assert.deepEqual(
    resolveExtractedRange(
      { startPeriod: "PI2026-10", endPeriod: "PI2026-09" },
      periods,
    ),
    { error: "Issue range starts after it ends (2026-10-01 > 2026-09-30)" },
  );
  assert.deepEqual(
    resolveExtractedRange(
      { start: "2026-10-15", endPeriod: "PI2026-09" },
      periods,
    ),
    { error: "Issue range starts after it ends (2026-10-15 > 2026-09-30)" },
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

function item(
  itemId: number,
  startDate: string,
  endDate: string,
  issueKeys: string[],
): ScheduleCheckItem {
  return {
    itemId,
    title: `Item ${itemId}`,
    laneName: "Delivery",
    laneColor: "green",
    parentTitle: null,
    startDate,
    endDate,
    issueKeys,
  };
}

test("comparison checks only issue overhang", () => {
  const items = [item(1, "2026-09-01", "2026-09-30", ["PAY-1", "PAY-2", "PAY-3"])];
  const results: TrackerScheduleResult[] = [
    { key: "PAY-1", state: "ok", start: "2026-08-31", end: "2026-09-15" },
    { key: "PAY-2", state: "ok", start: "2026-09-10", end: "2026-10-01" },
    { key: "PAY-3", state: "ok", start: "2026-09-10", end: "2026-09-15" },
  ];
  const projected = projectScheduleCheck(items, results, periods);
  assert.deepEqual(
    projected.rows[0]!.issues.map((issue) => issue.outside),
    [true, true, false],
  );
  assert.deepEqual(
    projected.rows[0]!.issues.map((issue) => issue.state === "ok"
      ? [issue.startOutside, issue.endOutside]
      : [undefined, undefined]),
    [[true, false], [false, true], [false, false]],
  );
  assert.equal(projected.rows[0]!.outside, true);
  assert.equal(projected.summary.checked, 3);
  assert.equal(projected.summary.outsidePairs, 2);
  assert.equal(projected.summary.outsideItems, 1);
});

test("one issue is compared independently with every linked item", () => {
  const items = [
    item(1, "2026-09-01", "2026-09-30", ["PAY-1"]),
    item(2, "2026-09-10", "2026-09-20", ["PAY-1"]),
  ];
  const results: TrackerScheduleResult[] = [
    { key: "PAY-1", state: "ok", start: "2026-09-05", end: "2026-09-25" },
  ];
  const projected = projectScheduleCheck(items, results, periods);
  assert.deepEqual(
    projected.rows.map((row) => row.outside),
    [false, true],
  );
  assert.equal(projected.summary.checked, 2);
  assert.equal(projected.summary.outsidePairs, 1);
});

test("period references resolve before comparison", () => {
  const projected = projectScheduleCheck(
    [item(1, "2026-09-01", "2026-09-30", ["PAY-1"])],
    [
      {
        key: "PAY-1",
        state: "ok",
        startPeriod: "PI2026-09",
        endPeriod: "PI2026-10",
      },
    ],
    periods,
  );
  assert.deepEqual(projected.rows[0]!.issues[0], {
    key: "PAY-1",
    state: "ok",
    startPeriod: "PI2026-09",
    endPeriod: "PI2026-10",
    start: "2026-09-01",
    end: "2026-10-31",
    startOutside: false,
    endOutside: true,
    outside: true,
  });
});

test("missing periods and issue states remain local to their pairs", () => {
  const items = [item(1, "2026-09-01", "2026-09-30", ["PAY-1", "PAY-2", "PAY-3", "PAY-4", "PAY-5"])];
  const results: TrackerScheduleResult[] = [
    { key: "PAY-1", state: "ok", startPeriod: "Whatever" },
    { key: "PAY-2", state: "skipped" },
    { key: "PAY-3", state: "error", errorKind: "script", error: "boom" },
    { key: "PAY-4", state: "notFound" },
  ];
  const projected = projectScheduleCheck(items, results, periods);
  assert.deepEqual(
    projected.rows[0]!.issues.map((issue) => issue.state),
    ["error", "skipped", "error", "notFound", "unchecked"],
  );
  assert.deepEqual(projected.summary, {
    items: 1,
    pairs: 5,
    checked: 0,
    outsidePairs: 0,
    outsideItems: 0,
    skipped: 1,
    errors: 2,
    notFound: 1,
    unchecked: 1,
  });
});

test("schedule check keys de-duplicate across item pairs in first-seen order", () => {
  assert.deepEqual(
    scheduleCheckKeys([
      item(1, "2026-09-01", "2026-09-30", ["PAY-2", "PAY-1"]),
      item(2, "2026-09-01", "2026-09-30", ["PAY-1", "PAY-3"]),
    ]),
    ["PAY-2", "PAY-1", "PAY-3"],
  );
});

test("report separates discrepancies from successful and failed issues", () => {
  const projected = projectScheduleCheck(
    [
      item(1, "2026-09-01", "2026-09-30", ["PAY-1", "PAY-2", "PAY-3"]),
      item(2, "2026-09-01", "2026-10-31", ["PAY-1", "PAY-2", "PAY-4"]),
    ],
    [
      { key: "PAY-1", state: "ok", start: "2026-09-10", end: "2026-10-15" },
      { key: "PAY-2", state: "error", errorKind: "script", error: "boom" },
      { key: "PAY-3", state: "skipped" },
      { key: "PAY-4", state: "notFound" },
    ],
    periods,
  );
  assert.deepEqual(reportScheduleCheck(projected), {
    matchingIssues: 1,
    matchingItems: 1,
    skippedIssues: 1,
    uncheckedIssues: 0,
    problems: {
      script: [{ key: "PAY-2", issue: undefined, message: "boom" }],
      tracker: [],
      schedule: [],
      notFound: [{ key: "PAY-4", issue: undefined }],
    },
  });
});
