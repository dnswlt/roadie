// Pure density and label-fit decisions for the timeline ruler. Measurement stays with
// the renderer, so the zoom thresholds can be pinned without a DOM.

import { dayOf, monthTicks, quarterTicks, yearTicks, MS_PER_DAY, type Scale, type Tick } from "./timescale";
import type { SchedulePeriod } from "./types";

export type CalendarUnit = "month" | "quarter" | "year";

export interface CalendarRuler {
  unit: CalendarUnit;
  ticks: Tick[];
}

export interface LabelMetrics {
  textWidth: (label: string) => number;
  inset: number; // horizontal padding and borders, measured from CSS
}

// Density budgets choose the calendar grain, not whether an individual label
// fits. Edge cells may be clipped but still have room for their actual text.
const CALENDAR_DENSITY_PX = { month: 50, quarter: 64 };

// Calendar labels include the year because schedule names need not. Choose
// their grain independently of period names, reserving room for the text and
// whitespace. Use full units (the shortest month/quarter), so clipped edge
// cells cannot coarsen the whole ruler.
export function scheduleCalendarRuler(scale: Scale): CalendarRuler {
  if (28 * scale.pxPerDay >= CALENDAR_DENSITY_PX.month) {
    return { unit: "month", ticks: monthTicks(scale, true) };
  }
  if (90 * scale.pxPerDay >= CALENDAR_DENSITY_PX.quarter) {
    return { unit: "quarter", ticks: quarterTicks(scale) };
  }
  return { unit: "year", ticks: yearTicks(scale) };
}

export function calendarLabelFits(label: string, width: number, metrics: LabelMetrics): boolean {
  return width >= metrics.textWidth(label) + metrics.inset;
}

// Schedule boundaries supply the detailed grid; only years supplement them,
// regardless of the header's label grain. A clipped year cell is a label span,
// not a year boundary, so it must not introduce a line at the chart's edge.
export function calendarGridTicks(scale: Scale, hasSchedule: boolean): Tick[] {
  if (!hasSchedule) return monthTicks(scale);
  return yearTicks(scale).filter(t => {
    const date = new Date(t.day * MS_PER_DAY);
    return date.getUTCMonth() === 0 && date.getUTCDate() === 1;
  });
}

// A schedule row needs whitespace as a whole, not merely enough room to avoid
// clipping one short name: otherwise fully rendered labels still become the
// picket fence compact mode is meant to remove. The text also gets 8px beyond
// .th-period's own 8px horizontal padding.
const MIN_NAMED_PERIOD_WIDTH = 80;
const PERIOD_LABEL_SPACE = 16;

export function scheduleLabelFits(
  period: SchedulePeriod,
  pxPerDay: number,
  labelWidth: (label: string) => number,
): boolean {
  const days = dayOf(period.endDate) + 1 - dayOf(period.startDate);
  const available = days * pxPerDay;
  return (
    available >=
    Math.max(MIN_NAMED_PERIOD_WIDTH, labelWidth(period.label) + PERIOD_LABEL_SPACE)
  );
}

// Hide names across the schedule band once unreadable cells are the majority.
// One unusually long name therefore disappears on its own without forcing an
// otherwise legible schedule into an unnamed band.
export function scheduleHeaderIsCompact(
  periods: SchedulePeriod[],
  pxPerDay: number,
  labelWidth: (label: string) => number,
): boolean {
  if (periods.length === 0) return false;
  const hidden = periods.filter(
    (period) => !scheduleLabelFits(period, pxPerDay, labelWidth),
  ).length;
  return hidden > periods.length / 2;
}
