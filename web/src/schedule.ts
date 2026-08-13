// Pure helpers for a roadmap's schedule (sprints, PIs, ...): parse/serialize the
// textarea editor format, and derive the snap boundaries the timeline clicks to.
// DOM-free so it can be unit-tested (schedule.test.ts) with node:test.

import { dayOf } from "./timescale";
import type { NewSchedulePeriod, SchedulePeriod } from "./types";

export interface ParsedSchedule {
  periods: NewSchedulePeriod[];
  errors: string[]; // human-readable, one per bad line; empty means all good
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// isValidDate rejects both malformed strings and impossible calendar dates
// (e.g. 2026-02-30, which Date would silently roll over).
function isValidDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === s;
}

// parseSchedule reads the editor format: one period per line, `START END LABEL`
// with whitespace-separated ISO dates (END inclusive) and the label being the
// rest of the line. Blank lines and lines starting with `#` are ignored. It
// collects per-line errors rather than throwing, so the editor can show them
// all at once; `periods` holds only the lines that parsed.
export function parseSchedule(text: string): ParsedSchedule {
  const periods: NewSchedulePeriod[] = [];
  const errors: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) {
      errors.push(`Line ${i + 1}: expected "START END LABEL"`);
      continue;
    }
    const [, start, end, label] = m;
    if (!isValidDate(start!)) {
      errors.push(`Line ${i + 1}: invalid start date "${start}" (want YYYY-MM-DD)`);
      continue;
    }
    if (!isValidDate(end!)) {
      errors.push(`Line ${i + 1}: invalid end date "${end}" (want YYYY-MM-DD)`);
      continue;
    }
    if (dayOf(end!) < dayOf(start!)) {
      errors.push(`Line ${i + 1}: end date is before start date`);
      continue;
    }
    periods.push({ startDate: start!, endDate: end!, label: label!.trim() });
  }
  return { periods, errors };
}

// serializeSchedule renders periods back to the editor format, ordered by start
// date, so opening the editor round-trips a stored schedule.
export function serializeSchedule(periods: SchedulePeriod[]): string {
  return [...periods]
    .sort((a, b) => dayOf(a.startDate) - dayOf(b.startDate))
    .map((p) => `${p.startDate} ${p.endDate} ${p.label}`)
    .join("\n");
}

// periodsByStart is the order periods are shown in. The store returns them
// sorted already; option order is the view's business, not a query's.
export function periodsByStart(periods: SchedulePeriod[]): SchedulePeriod[] {
  return [...periods].sort((a, b) => dayOf(a.startDate) - dayOf(b.startDate));
}

// periodAtEdge matches an edge exactly, never the period a date merely falls
// inside: it lets a picker state a fact rather than a guess, so re-picking the
// entry already shown can't silently move a hand-typed date to a boundary.
export function periodAtEdge(
  periods: SchedulePeriod[],
  edge: "start" | "end",
  date: string,
): SchedulePeriod | null {
  return periods.find((p) => (edge === "start" ? p.startDate : p.endDate) === date) ?? null;
}

// periodDates sets one edge to a period and leaves the other alone — unless
// that would invert the range, in which case the item collapses onto the chosen
// period. The alternative is answering a deliberate pick with the store's
// rejection toast; this way every option in the list does something.
export function periodDates(
  edge: "start" | "end",
  period: SchedulePeriod,
  current: { startDate: string; endDate: string },
): { startDate: string; endDate: string } {
  if (edge === "start") {
    const keepsOrder = dayOf(current.endDate) >= dayOf(period.startDate);
    return { startDate: period.startDate, endDate: keepsOrder ? current.endDate : period.endDate };
  }
  const keepsOrder = dayOf(current.startDate) <= dayOf(period.endDate);
  return { startDate: keepsOrder ? current.startDate : period.startDate, endDate: period.endDate };
}

// scheduleBounds returns the sorted, de-duplicated snap boundaries of a schedule
// in the boundary/day-number domain: each period contributes its start and
// end + 1 (a bar owns pixels [xOf(start), xOf(end + 1)), so edges live here).
export function scheduleBounds(periods: SchedulePeriod[]): number[] {
  const set = new Set<number>();
  for (const p of periods) {
    set.add(dayOf(p.startDate));
    set.add(dayOf(p.endDate) + 1);
  }
  return [...set].sort((a, b) => a - b);
}

// nearestBoundary returns the boundary in `sorted` closest to `day` (ties round
// down, to the earlier boundary), or `day` unchanged when there are none.
export function nearestBoundary(day: number, sorted: number[]): number {
  let best = day;
  let bestDist = Infinity;
  for (const b of sorted) {
    const dist = Math.abs(day - b);
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  return best;
}
