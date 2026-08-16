import { strict as assert } from "node:assert";
import { test } from "node:test";
import { editRangeDate, isValidDate, parseDateInput } from "./dates";

test("isValidDate accepts only real ISO calendar dates", () => {
  assert.equal(isValidDate("2026-02-28"), true);
  assert.equal(isValidDate("2026-02-30"), false);
  assert.equal(isValidDate("2026-2-28"), false);
});

test("editRangeDate collapses a crossed range onto the entered date", () => {
  const dates = { startDate: "2026-02-01", endDate: "2026-02-28" };
  assert.deepEqual(editRangeDate("start", "2026-03-10", dates), {
    startDate: "2026-03-10",
    endDate: "2026-03-10",
  });
  assert.deepEqual(editRangeDate("end", "2026-01-10", dates), {
    startDate: "2026-01-10",
    endDate: "2026-01-10",
  });
  assert.deepEqual(editRangeDate("start", "2026-01-10", dates), {
    startDate: "2026-01-10",
    endDate: "2026-02-28",
  });
});

test("editRangeDate rejects anything that is not a real ISO date", () => {
  const dates = { startDate: "2026-02-01", endDate: "2026-02-28" };
  assert.throws(() => editRangeDate("start", "2027-7-1", dates), /requires valid dates/);
  // Parseable but impossible: Date rolls this over to 2026-03-02.
  assert.throws(() => editRangeDate("start", "2026-02-30", dates), /requires valid dates/);
  assert.throws(
    () => editRangeDate("start", "2026-03-10", { startDate: "2026-02-01", endDate: "" }),
    /requires valid dates/,
  );
});

test("parseDateInput leaves an exact ISO date exact", () => {
  assert.equal(parseDateInput(" 2026-07-14 ", "start"), "2026-07-14");
  assert.equal(parseDateInput("2026-07-14", "end"), "2026-07-14");
});

test("parseDateInput resolves a month at the edited edge", () => {
  assert.equal(parseDateInput("04/2026", "start"), "2026-04-01");
  assert.equal(parseDateInput("4 / 2026", "end"), "2026-04-30");
  assert.equal(parseDateInput("02/2028", "end"), "2028-02-29");
  assert.equal(parseDateInput("4/26", "start", 2026), "2026-04-01");
});

test("parseDateInput resolves a quarter at the edited edge", () => {
  assert.equal(parseDateInput("q3 2026", "start"), "2026-07-01");
  assert.equal(parseDateInput("Q3  2026", "end"), "2026-09-30");
  assert.equal(parseDateInput("q1 26", "start", 2026), "2026-01-01");
  assert.equal(parseDateInput("Q1/2026", "end"), "2026-03-31");
  assert.equal(parseDateInput("q 1 / 26", "end", 2026), "2026-03-31");
});

test("two-digit years use a rolling century around the reference year", () => {
  // In 2026 the window is 2006..2105, inclusive.
  assert.equal(parseDateInput("1/06", "start", 2026), "2006-01-01");
  assert.equal(parseDateInput("1/05", "start", 2026), "2105-01-01");
  assert.equal(parseDateInput("1/20", "start", 2026), "2020-01-01");
  assert.equal(parseDateInput("1/00", "start", 2026), "2100-01-01");
  // The same rule keeps moving after the turn of the century.
  assert.equal(parseDateInput("1/00", "start", 2098), "2100-01-01");
});

test("parseDateInput rejects invalid and ambiguous forms", () => {
  for (const value of [
    "",
    "2026-02-30",
    "13/2026",
    "q5 2026",
    "04/05/2026",
    "2026",
    "q1-26",
  ]) {
    assert.equal(parseDateInput(value, "start"), null, value);
  }
});
