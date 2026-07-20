// Date <-> pixel math. Dates are handled as integer day numbers
// (days since the Unix epoch, UTC) to keep arithmetic trivial.

import type { RoadmapFull } from "./types";

export const MS_PER_DAY = 86_400_000;

export function dayOf(iso: string): number {
  return Math.round(Date.parse(iso + "T00:00:00Z") / MS_PER_DAY);
}

export function isoOf(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function todayDay(): number {
  const now = new Date();
  return Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY);
}

export interface Scale {
  startDay: number;
  endDay: number; // inclusive
  pxPerDay: number;
}

export const MIN_PX_PER_DAY = 0.6;
export const MAX_PX_PER_DAY = 16;
export const DEFAULT_PX_PER_DAY = 3;

export function xOf(scale: Scale, day: number): number {
  return (day - scale.startDay) * scale.pxPerDay;
}

// SnapMode is the calendar grid a dragged/resized edge snaps to when it isn't
// caught by a nearby item edge. "day" = no grid (free per-day placement). See
// snapToGrid and dnd.ts. This is a user-chosen view preference, not zoom-derived:
// the right grain for a roadmap depends on how you're planning, not how far
// you've zoomed.
export type SnapMode = "day" | "week" | "month" | "quarter";

// weekStart returns the day number of the Monday on or before `day`. Day 0
// (1970-01-01) is a Thursday, so the ISO weekday (Mon=0..Sun=6) is (day+3) mod 7.
export function weekStart(day: number): number {
  return day - ((((day + 3) % 7) + 7) % 7);
}

// quarterStart returns the day number of the first day of the quarter (Jan/Apr/
// Jul/Oct 1) containing `day`.
export function quarterStart(day: number): number {
  const d = new Date(day * MS_PER_DAY);
  const q = Math.floor(d.getUTCMonth() / 3) * 3;
  return Math.round(Date.UTC(d.getUTCFullYear(), q, 1) / MS_PER_DAY);
}

// snapToGrid rounds `day` to the nearest boundary of the given calendar grid
// (ties round down, to the earlier boundary). "day" mode is the identity.
export function snapToGrid(day: number, mode: SnapMode): number {
  let lo: number;
  let hi: number;
  switch (mode) {
    case "week":
      lo = weekStart(day);
      hi = lo + 7;
      break;
    case "month":
      lo = monthStart(day, 0);
      hi = monthStart(day, 1);
      break;
    case "quarter":
      lo = quarterStart(day);
      hi = quarterStart(lo + 100); // +100d lands in the next quarter (max 92d)
      break;
    default:
      return day;
  }
  return day - lo <= hi - day ? lo : hi;
}

export function chartWidth(scale: Scale): number {
  return (scale.endDay - scale.startDay + 1) * scale.pxPerDay;
}

// computeRange derives the visible horizon from the data: all items plus
// today, padded and snapped to month boundaries.
export function computeRange(rm: RoadmapFull | null, today: number): { startDay: number; endDay: number } {
  let min = today;
  let max = today;
  if (rm) {
    for (const lane of rm.lanes) {
      for (const item of lane.items) {
        min = Math.min(min, dayOf(item.startDate));
        max = Math.max(max, dayOf(item.endDate));
        for (const c of item.children) {
          min = Math.min(min, dayOf(c.startDate));
          max = Math.max(max, dayOf(c.endDate));
        }
      }
      for (const m of lane.milestones) {
        const d = dayOf(m.date);
        min = Math.min(min, d);
        max = Math.max(max, d);
      }
    }
  }
  return { startDay: monthStart(min, -1), endDay: monthStart(max, 3) - 1 };
}

// monthStart returns the day number of the first day of the month `offset`
// months relative to the month containing `day`.
export function monthStart(day: number, offset: number): number {
  const d = new Date(day * MS_PER_DAY);
  return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1) / MS_PER_DAY);
}

export interface Tick {
  day: number;
  days: number; // width of the tick period in days (clipped to the scale)
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthTicks(scale: Scale): Tick[] {
  const ticks: Tick[] = [];
  let day = monthStart(scale.startDay, 0);
  while (day <= scale.endDay) {
    const next = monthStart(day, 1);
    const d = new Date(day * MS_PER_DAY);
    const from = Math.max(day, scale.startDay);
    const to = Math.min(next - 1, scale.endDay);
    ticks.push({ day: from, days: to - from + 1, label: MONTHS[d.getUTCMonth()] ?? "" });
    day = next;
  }
  return ticks;
}

export function quarterTicks(scale: Scale): Tick[] {
  const ticks: Tick[] = [];
  const first = new Date(monthStart(scale.startDay, 0) * MS_PER_DAY);
  let day = Math.round(
    Date.UTC(first.getUTCFullYear(), Math.floor(first.getUTCMonth() / 3) * 3, 1) / MS_PER_DAY,
  );
  while (day <= scale.endDay) {
    const d = new Date(day * MS_PER_DAY);
    const next = Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1) / MS_PER_DAY);
    const from = Math.max(day, scale.startDay);
    const to = Math.min(next - 1, scale.endDay);
    const q = Math.floor(d.getUTCMonth() / 3) + 1;
    ticks.push({ day: from, days: to - from + 1, label: `Q${q} ${d.getUTCFullYear()}` });
    day = next;
  }
  return ticks;
}

export function formatDay(day: number): string {
  const d = new Date(day * MS_PER_DAY);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
