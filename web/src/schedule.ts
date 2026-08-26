// Pure helpers for a roadmap's schedule (sprints, PIs, ...): parse/serialize the
// textarea editor format, and derive the snap boundaries the timeline clicks to.
// DOM-free so it can be unit-tested (schedule.test.ts) with node:test.

import { isValidDate } from "./dates";
import { dayOf } from "./timescale";
import type { NewSchedulePeriod, SchedulePeriod } from "./types";

export interface ParsedSchedule {
  periods: NewSchedulePeriod[];
  errors: string[]; // human-readable, one per bad line; empty means all good
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

// The WBS speaks in periods where it can. An item is named by the periods its
// two edges fall *inside*, not only by the ones it is flush with: someone who
// plans in PIs wants to read which PIs a piece of work occupies, and the exact
// dates are a click away in the edit rail. A tilde carries the imprecision:
// between two labels it replaces the en dash that means the range fills them
// exactly, and ahead of a single label it says the range lies within it.
//
// This is the opposite trade from periodAtEdge, which the panel's picker uses:
// a picker must state a fact, because re-picking what it shows would move the
// date. Nothing here is actionable, so containment can be shown honestly.
const RANGE_SEP = "–";
const WITHIN_SEP = "~";

// periodContaining returns the period whose inclusive span covers `date`.
// Periods are disjoint (the store rejects overlaps) but need not be
// contiguous, so a date can legitimately match none: before the first, after
// the last, or in a gap.
export function periodContaining(
  periods: SchedulePeriod[],
  date: string,
): SchedulePeriod | null {
  const d = dayOf(date);
  return periods.find((p) => dayOf(p.startDate) <= d && d <= dayOf(p.endDate)) ?? null;
}

// periodRangeText names a range by the periods it occupies, or gives the plain
// dates when it cannot. A range inside one period collapses to that label,
// since the separator is the only thing a second copy of it would add; the
// tilde then moves in front of the label.
//
// Falling back is all-or-nothing: an edge outside every period sends the whole
// range back to dates rather than printing a date beside a period name, which
// would read as two vocabularies in one cell.
export function periodRangeText(
  periods: SchedulePeriod[],
  startDate: string,
  endDate: string,
  formatDate: (iso: string) => string,
): string {
  const from = periodContaining(periods, startDate);
  const to = periodContaining(periods, endDate);
  if (from === null || to === null) {
    return `${formatDate(startDate)} ${RANGE_SEP} ${formatDate(endDate)}`;
  }
  const fills = from.startDate === startDate && to.endDate === endDate;
  if (from === to) return fills ? from.label : `${WITHIN_SEP} ${from.label}`;
  return `${from.label} ${fills ? RANGE_SEP : WITHIN_SEP} ${to.label}`;
}

// periodPointText is periodRangeText for a milestone's single date: the period
// it falls in, or the date when it falls outside them all. There is no
// separator to qualify, so a point is never marked as inexact.
export function periodPointText(
  periods: SchedulePeriod[],
  date: string,
  formatDate: (iso: string) => string,
): string {
  return periodContaining(periods, date)?.label ?? formatDate(date);
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
