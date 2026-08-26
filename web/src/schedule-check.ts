import type { SchedulePeriod } from "./types";

export interface ExtractedRange {
  start?: string;
  end?: string;
  startPeriod?: string;
  endPeriod?: string;
}

export interface ResolvedRange {
  start?: string;
  end?: string;
  error?: string;
}

// Period references use the same exact, case-sensitive labels as the schedule
// editor. A bad reference belongs to this issue; callers continue with the
// remaining extracted results.
export function resolveExtractedRange(
  range: ExtractedRange,
  periods: SchedulePeriod[],
): ResolvedRange {
  let { start, end } = range;
  if (!range.startPeriod && !range.endPeriod) return { start, end };
  if (periods.length === 0) return { error: "Roadmap has no schedule" };

  const byLabel = new Map(periods.map((period) => [period.label, period]));
  if (range.startPeriod) {
    const period = byLabel.get(range.startPeriod);
    if (!period) {
      return { error: `Schedule period "${range.startPeriod}" not found` };
    }
    start = period.startDate;
  }
  if (range.endPeriod) {
    const period = byLabel.get(range.endPeriod);
    if (!period) return { error: `Schedule period "${range.endPeriod}" not found` };
    end = period.endDate;
  }
  return { start, end };
}
