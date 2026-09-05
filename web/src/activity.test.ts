import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  activityBuckets,
  activityProfile,
  activityStats,
  activityStepPath,
} from "./activity";
import { dayOf, isoOf } from "./timescale";
import type { Item, ItemFull, LaneFull, SchedulePeriod } from "./types";

function item(startDate: string, endDate: string, children: Item[] = []): ItemFull {
  return {
    id: 1,
    laneId: 1,
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

function lane(items: ItemFull[]): LaneFull {
  return {
    id: 1,
    roadmapId: 1,
    name: "x",
    position: 0,
    color: "blue",
    items,
    milestones: [],
  };
}

function period(startDate: string, endDate: string, label: string): SchedulePeriod {
  return { id: 1, startDate, endDate, label };
}

test("activityProfile counts inclusive top-level item ranges but not children", () => {
  const child = item("2024-01-01", "2024-01-06");
  const profile = activityProfile(
    [lane([item("2024-01-01", "2024-01-03", [child]), item("2024-01-03", "2024-01-05")])],
    dayOf("2024-01-01"),
    dayOf("2024-01-06"),
  );

  assert.equal(profile.peak, 2);
  assert.deepEqual(
    profile.spans.map((span) => ({
      start: isoOf(span.startDay),
      end: isoOf(span.endBoundary),
      count: span.count,
    })),
    [
      { start: "2024-01-01", end: "2024-01-03", count: 1 },
      { start: "2024-01-03", end: "2024-01-04", count: 2 },
      { start: "2024-01-04", end: "2024-01-06", count: 1 },
      { start: "2024-01-06", end: "2024-01-07", count: 0 },
    ],
  );
});

test("activityProfile clips items to the chart and preserves empty spans", () => {
  const profile = activityProfile(
    [lane([item("2024-01-01", "2024-01-02"), item("2024-01-04", "2024-01-06")])],
    dayOf("2024-01-02"),
    dayOf("2024-01-04"),
  );

  assert.deepEqual(profile.spans.map((span) => span.count), [1, 0, 1]);
  assert.deepEqual(profile.spans.map((span) => span.endBoundary - span.startDay), [1, 1, 1]);
});

test("activityStats reports the average daily and peak counts", () => {
  const profile = activityProfile(
    [lane([item("2024-01-01", "2024-01-05"), item("2024-01-03", "2024-01-03")])],
    dayOf("2024-01-01"),
    dayOf("2024-01-05"),
  );
  assert.deepEqual(activityStats(profile, dayOf("2024-01-01"), dayOf("2024-01-06")), {
    average: 1.2,
    peak: 2,
  });
});

test("activityBuckets uses schedule periods and months in their gaps", () => {
  const buckets = activityBuckets(
    dayOf("2024-01-01"),
    dayOf("2024-03-31"),
    [period("2024-01-15", "2024-02-15", "PI 1")],
  );

  assert.deepEqual(
    buckets.map((bucket) => ({
      start: isoOf(bucket.startDay),
      end: isoOf(bucket.endBoundary),
      label: bucket.label,
    })),
    [
      { start: "2024-01-01", end: "2024-01-15", label: "Jan 2024" },
      { start: "2024-01-15", end: "2024-02-16", label: "PI 1" },
      { start: "2024-02-16", end: "2024-03-01", label: "Feb 2024" },
      { start: "2024-03-01", end: "2024-04-01", label: "Mar 2024" },
    ],
  );
});

test("activityStepPath changes height only at item boundaries", () => {
  const profile = activityProfile(
    [lane([item("2024-01-01", "2024-01-02"), item("2024-01-02", "2024-01-03")])],
    dayOf("2024-01-01"),
    dayOf("2024-01-03"),
  );
  assert.equal(activityStepPath(profile, 10, 8, 88), "M 0 88 L 0 48 H 10 V 8 H 20 V 48 H 30 V 88 Z");
});
