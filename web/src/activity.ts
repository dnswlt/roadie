// Derives the timeline's active-item profile. The calculation stays in the
// boundary/day domain used by item bars: an inclusive item range occupies
// [start, end + 1), and each span below does the same.

import { dayOf, monthStart, MS_PER_DAY } from "./timescale";
import type { LaneFull, SchedulePeriod } from "./types";

export interface ActivitySpan {
  startDay: number;
  endBoundary: number;
  count: number;
}

export interface ActivityProfile {
  startDay: number;
  endBoundary: number;
  spans: ActivitySpan[];
  peak: number;
}

export interface ActivityBucket {
  startDay: number;
  endBoundary: number;
  label: string;
}

export interface ActivityStats {
  average: number;
  peak: number;
}

// activityProfile counts top-level items only. Counting both a parent and its
// children would make decomposition inflate the apparent amount of active
// roadmap content.
export function activityProfile(
  lanes: LaneFull[],
  startDay: number,
  endDay: number,
): ActivityProfile {
  const endBoundary = endDay + 1;
  const events = new Map<number, number>();
  const add = (day: number, delta: number): void => {
    events.set(day, (events.get(day) ?? 0) + delta);
  };

  for (const lane of lanes) {
    for (const item of lane.items) {
      const start = Math.max(startDay, dayOf(item.startDate));
      const end = Math.min(endBoundary, dayOf(item.endDate) + 1);
      if (start >= end) continue;
      add(start, 1);
      add(end, -1);
    }
  }

  const spans: ActivitySpan[] = [];
  let cursor = startDay;
  let count = 0;
  let peak = 0;
  for (const day of [...events.keys()].sort((a, b) => a - b)) {
    if (day > cursor) {
      spans.push({ startDay: cursor, endBoundary: day, count });
      peak = Math.max(peak, count);
    }
    count += events.get(day) ?? 0;
    cursor = day;
  }
  if (cursor < endBoundary) {
    spans.push({ startDay: cursor, endBoundary, count });
    peak = Math.max(peak, count);
  }

  return { startDay, endBoundary, spans, peak };
}

export function activityStats(
  profile: ActivityProfile,
  startDay: number,
  endBoundary: number,
): ActivityStats {
  const days = endBoundary - startDay;
  if (days <= 0) return { average: 0, peak: 0 };

  let itemDays = 0;
  let peak = 0;
  for (const span of profile.spans) {
    const start = Math.max(startDay, span.startDay);
    const end = Math.min(endBoundary, span.endBoundary);
    if (start >= end) continue;
    itemDays += (end - start) * span.count;
    peak = Math.max(peak, span.count);
  }
  return { average: itemDays / days, peak };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(day: number): string {
  const date = new Date(day * MS_PER_DAY);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function appendMonthBuckets(out: ActivityBucket[], startDay: number, endBoundary: number): void {
  let cursor = startDay;
  while (cursor < endBoundary) {
    const next = Math.min(endBoundary, monthStart(cursor, 1));
    out.push({ startDay: cursor, endBoundary: next, label: monthLabel(cursor) });
    cursor = next;
  }
}

// activityBuckets uses schedule periods where the roadmap defines them and
// calendar months in every uncovered range. Schedule periods may be sparse,
// so falling back only when there is no schedule would leave gaps uninspectable.
export function activityBuckets(
  startDay: number,
  endDay: number,
  periods: SchedulePeriod[],
): ActivityBucket[] {
  const endBoundary = endDay + 1;
  if (periods.length === 0) {
    const out: ActivityBucket[] = [];
    appendMonthBuckets(out, startDay, endBoundary);
    return out;
  }

  const clipped = periods
    .map((period) => ({
      startDay: Math.max(startDay, dayOf(period.startDate)),
      endBoundary: Math.min(endBoundary, dayOf(period.endDate) + 1),
      label: period.label,
    }))
    .filter((period) => period.startDay < period.endBoundary)
    .sort((a, b) => a.startDay - b.startDay);

  const out: ActivityBucket[] = [];
  let cursor = startDay;
  for (const period of clipped) {
    if (cursor < period.startDay) appendMonthBuckets(out, cursor, period.startDay);
    const start = Math.max(cursor, period.startDay);
    if (start < period.endBoundary) {
      out.push({ startDay: start, endBoundary: period.endBoundary, label: period.label });
      cursor = period.endBoundary;
    }
  }
  if (cursor < endBoundary) appendMonthBuckets(out, cursor, endBoundary);
  return out;
}

function pathNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

// activityStepPath renders the daily values as one filled step polygon. Equal
// adjacent days are already coalesced into spans, so the path changes only at
// item boundaries rather than creating one SVG element per day.
export function activityStepPath(
  profile: ActivityProfile,
  pxPerDay: number,
  top: number,
  bottom: number,
): string {
  if (profile.peak === 0 || profile.spans.length === 0) return "";
  const x = (day: number): number => (day - profile.startDay) * pxPerDay;
  const y = (count: number): number => bottom - (count / profile.peak) * (bottom - top);
  const first = profile.spans[0]!;
  let path = `M 0 ${pathNumber(bottom)} L 0 ${pathNumber(y(first.count))}`;
  for (let i = 0; i < profile.spans.length; i++) {
    const span = profile.spans[i]!;
    path += ` H ${pathNumber(x(span.endBoundary))}`;
    const next = profile.spans[i + 1];
    if (next && next.count !== span.count) path += ` V ${pathNumber(y(next.count))}`;
  }
  return `${path} V ${pathNumber(bottom)} Z`;
}
