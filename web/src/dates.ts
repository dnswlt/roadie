// Pure date validation and edit-input helpers. The model stores exact ISO
// dates; the small input language here only decides which exact boundary a
// user meant before anything reaches the model.

import { dayOf } from "./timescale";

export type DateEdge = "start" | "end";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// isValidDate rejects both malformed strings and impossible calendar dates
// (e.g. 2026-02-30, which Date would silently roll over).
export function isValidDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const timestamp = Date.parse(value + "T00:00:00Z");
  if (Number.isNaN(timestamp)) return false;
  return new Date(timestamp).toISOString().slice(0, 10) === value;
}

// editRangeDate applies a hand-entered edge without ever producing an invalid
// range: crossing the other edge makes the item a one-day item at the entered
// date, rather than leaving a rejected value in the editor. A resize drag
// clamps to the untouched edge instead (dnd.ts) — a typed date is a deliberate
// assertion, not a gesture passing through. Every date must be a real ISO
// calendar date; a caller that cannot promise that has to validate first.
export function editRangeDate(
  edge: DateEdge,
  date: string,
  current: { startDate: string; endDate: string },
): { startDate: string; endDate: string } {
  if (![date, current.startDate, current.endDate].every(isValidDate)) {
    throw new Error("editRangeDate requires valid dates");
  }
  const day = dayOf(date);
  if (edge === "start") {
    return { startDate: date, endDate: day > dayOf(current.endDate) ? date : current.endDate };
  }
  return { startDate: day < dayOf(current.startDate) ? date : current.startDate, endDate: date };
}

function monthEdge(year: string, month: number, edge: DateEdge): string | null {
  const mm = String(month).padStart(2, "0");
  const first = `${year}-${mm}-01`;
  if (!isValidDate(first)) return null;
  if (edge === "start") return first;
  for (let day = 31; day >= 28; day--) {
    const candidate = `${year}-${mm}-${String(day).padStart(2, "0")}`;
    if (isValidDate(candidate)) return candidate;
  }
  return null;
}

// expandYear maps a two-digit year into one rolling century: 20 years behind
// the reference year through 79 years ahead. That covers realistic roadmap
// history while remaining future-oriented and baking in no century boundary.
function expandYear(value: string, referenceYear: number): string | null {
  if (/^\d{4}$/.test(value)) return value;
  if (!/^\d{2}$/.test(value) || !Number.isInteger(referenceYear)) return null;
  const firstYear = referenceYear - 20;
  let year = Math.floor(firstYear / 100) * 100 + Number(value);
  if (year < firstYear) year += 100;
  return String(year).padStart(4, "0");
}

// parseDateInput accepts only unambiguous forms. A month or quarter resolves
// to the edge being edited: starts use its first day; ends and milestones use
// its last. Successful parses are always canonical ISO dates.
export function parseDateInput(
  text: string,
  edge: DateEdge,
  referenceYear = new Date().getFullYear(),
): string | null {
  const value = text.trim();
  if (isValidDate(value)) return value;

  const month = value.match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
  if (month) {
    const year = expandYear(month[2]!, referenceYear);
    return year === null ? null : monthEdge(year, Number(month[1]), edge);
  }

  const quarter = value.match(/^q\s*([1-4])(?:\s*\/\s*|\s+)(\d{2}|\d{4})$/i);
  if (quarter) {
    const year = expandYear(quarter[2]!, referenceYear);
    if (year === null) return null;
    const q = Number(quarter[1]);
    return monthEdge(year, edge === "start" ? (q - 1) * 3 + 1 : q * 3, edge);
  }

  return null;
}
