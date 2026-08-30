import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  calendarGridTicks,
  calendarLabelFits,
  scheduleCalendarRuler,
  scheduleHeaderIsCompact,
  scheduleLabelFits,
  type CalendarUnit,
  type LabelMetrics,
} from "./timeline-grid";
import { dayOf, isoOf, MAX_PX_PER_DAY, MIN_PX_PER_DAY, type Scale } from "./timescale";
import type { SchedulePeriod } from "./types";

function period(id: number, startDate: string, endDate: string, label = "Period"): SchedulePeriod {
  return { id, startDate, endDate, label };
}

function scale(pxPerDay: number): Scale {
  return { startDay: dayOf("2026-01-01"), endDay: dayOf("2026-12-31"), pxPerDay };
}

test("a schedule has only yearly calendar gridlines at every header grain", () => {
  for (const pxPerDay of [MAX_PX_PER_DAY, 3, 1, MIN_PX_PER_DAY]) {
    const s = { ...scale(pxPerDay), endDay: dayOf("2028-12-31") };
    assert.deepEqual(calendarGridTicks(s, true).map(t => isoOf(t.day)), [
      "2026-01-01", "2027-01-01", "2028-01-01",
    ]);
  }
});

test("a clipped year label does not introduce an off-boundary gridline", () => {
  const s = { ...scale(3), startDay: dayOf("2026-04-01"), endDay: dayOf("2027-04-01") };
  assert.deepEqual(calendarGridTicks(s, true).map(t => isoOf(t.day)), ["2027-01-01"]);
});

test("without a schedule the calendar grid remains monthly at every zoom", () => {
  for (const pxPerDay of [MAX_PX_PER_DAY, 3, 1, MIN_PX_PER_DAY]) {
    const ticks = calendarGridTicks(scale(pxPerDay), false);
    assert.equal(ticks.length, 12);
    assert.equal(isoOf(ticks[0]!.day), "2026-01-01");
    assert.equal(isoOf(ticks.at(-1)!.day), "2026-12-01");
  }
});

test("short sprint names can disappear while the calendar still shows months", () => {
  const sprints = [
    period(1, "2026-01-01", "2026-01-14", "Sprint 1"),
    period(2, "2026-01-15", "2026-01-28", "Sprint 2"),
  ];
  assert.equal(scheduleHeaderIsCompact(sprints, 3, () => 50), true);
  const ruler = scheduleCalendarRuler(scale(3));
  assert.equal(ruler.unit, "month");
  assert.equal(ruler.ticks.length, 12);
  assert.equal(ruler.ticks[0]?.label, "Jan 26");
});

test("the schedule calendar steps through months, quarters and years", () => {
  for (const [pxPerDay, unit] of [
    [MAX_PX_PER_DAY, "month"],
    [50 / 28, "month"],
    [50 / 28 - 0.001, "quarter"],
    [1, "quarter"],
    [64 / 90, "quarter"],
    [64 / 90 - 0.001, "year"],
    [MIN_PX_PER_DAY, "year"],
  ] as const) {
    assert.equal(scheduleCalendarRuler(scale(pxPerDay)).unit, unit, `pxPerDay=${pxPerDay}`);
  }
  const quarters = scheduleCalendarRuler(scale(1));
  assert.deepEqual(quarters.ticks.map(t => t.label), ["Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026"]);
  const years = scheduleCalendarRuler(scale(MIN_PX_PER_DAY));
  assert.deepEqual(years.ticks.map(t => t.label), ["2026"]);
});

test("clipped edge cells do not coarsen the calendar ruler", () => {
  const clipped = { startDay: dayOf("2026-03-30"), endDay: dayOf("2026-04-02") };
  for (const pxPerDay of [3, 1, MIN_PX_PER_DAY]) {
    const ruler = scheduleCalendarRuler({ ...clipped, pxPerDay });
    assert.equal(ruler.unit, scheduleCalendarRuler(scale(pxPerDay)).unit);
    assert.equal(ruler.ticks[0]?.day, clipped.startDay);
    const last = ruler.ticks.at(-1)!;
    assert.equal(last.day + last.days - 1, clipped.endDay);
  }
});

// Representative text measurements; browser-owned font/inset measurement is
// supplied to the same fit predicate that the renderer uses.
const calendarMetrics: Record<CalendarUnit, LabelMetrics> = {
  month: { textWidth: () => 36, inset: 7 },
  quarter: { textWidth: () => 48, inset: 7 },
  year: { textWidth: () => 28, inset: 1 },
};

test("clipped quarters and years retain labels that fit across New Year", () => {
  for (const [pxPerDay, expected] of [
    [1, ["Q4 2026", "Q1 2027"]],
    [MIN_PX_PER_DAY, ["2026", "2027"]],
  ] as const) {
    const s = { startDay: dayOf("2026-11-01"), endDay: dayOf("2027-02-28"), pxPerDay };
    const ruler = scheduleCalendarRuler(s);
    const visible = ruler.ticks.filter(t =>
      calendarLabelFits(t.label, t.days * pxPerDay, calendarMetrics[ruler.unit]),
    );
    assert.deepEqual(visible.map(t => t.label), expected);
  }
});

test("calendar label fit uses the actual text width plus CSS insets", () => {
  const metrics = { textWidth: (label: string) => label === "Jan" ? 18 : 26, inset: 7 };
  assert.equal(calendarLabelFits("Jan", 25, metrics), true);
  assert.equal(calendarLabelFits("Jan", 24.9, metrics), false);
  assert.equal(calendarLabelFits("May", 25, metrics), false);
  assert.equal(calendarLabelFits("May", 33, metrics), true);
  assert.equal(calendarLabelFits("May", 33, { ...metrics, inset: 8 }), false);
});

test("cells too narrow for their text still hide the label", () => {
  const s = { ...scale(1), startDay: dayOf("2026-03-30"), endDay: dayOf("2026-06-30") };
  const ruler = scheduleCalendarRuler(s);
  const visible = ruler.ticks.filter(t =>
    calendarLabelFits(t.label, t.days * s.pxPerDay, calendarMetrics[ruler.unit]),
  );
  assert.deepEqual(visible.map(t => t.label), ["Q2 2026"]);
});

test("full calendar cells fit representative labels at density transitions", () => {
  for (const pxPerDay of [50 / 28, 64 / 90, MIN_PX_PER_DAY]) {
    const ruler = scheduleCalendarRuler(scale(pxPerDay));
    assert.ok(ruler.ticks.every(t =>
      calendarLabelFits(t.label, t.days * pxPerDay, calendarMetrics[ruler.unit]),
    ));
  }
});

test("schedule labels fit against their inclusive period width", () => {
  const p = period(1, "2026-01-01", "2026-01-10");
  assert.equal(scheduleLabelFits(p, 8, () => 64), true); // 80px span and 64px + 16px space
  assert.equal(scheduleLabelFits(p, 7.9, () => 64), false);
});

test("the schedule header becomes compact when most labels do not fit", () => {
  const periods = [
    period(1, "2026-01-01", "2026-01-10", "A"),
    period(2, "2026-01-11", "2026-01-20", "B"),
    period(3, "2026-01-21", "2026-01-30", "C"),
  ];
  assert.equal(scheduleHeaderIsCompact(periods, 8, () => 13), false);
  assert.equal(scheduleHeaderIsCompact(periods, 7.9, () => 13), true);
});

test("one long label does not compact an otherwise readable schedule", () => {
  const periods = [
    period(1, "2026-01-01", "2026-01-10", "A"),
    period(2, "2026-01-11", "2026-01-20", "Unusually long"),
    period(3, "2026-01-21", "2026-01-30", "C"),
  ];
  const widths: Record<string, number> = { A: 10, "Unusually long": 100, C: 10 };
  assert.equal(scheduleHeaderIsCompact(periods, 8, (label) => widths[label]!), false);
});
