import type { ScheduleCheckItem } from "./recon-diff";
import type {
  SchedulePeriod,
  TrackerIssue,
  TrackerScheduleErrorKind,
  TrackerScheduleResult,
} from "./types";

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

interface ScheduleCheckIssueBase {
  key: string;
  issue?: TrackerIssue;
  checkedAt?: string;
  outside: boolean;
}

interface ScheduleCheckOKIssue extends ScheduleCheckIssueBase {
  state: "ok";
  start?: string;
  end?: string;
  startPeriod?: string;
  endPeriod?: string;
  label?: string;
  startOutside?: boolean;
  endOutside?: boolean;
}

interface ScheduleCheckErrorIssue extends ScheduleCheckIssueBase {
  state: "error";
  error: string;
  errorKind: TrackerScheduleErrorKind | "schedule";
  outside: false;
}

interface ScheduleCheckEmptyIssue extends ScheduleCheckIssueBase {
  state: "skipped" | "notFound" | "unchecked";
  outside: false;
}

export type ScheduleCheckIssue =
  | ScheduleCheckOKIssue
  | ScheduleCheckErrorIssue
  | ScheduleCheckEmptyIssue;

export type ScheduleCheckMismatch = ScheduleCheckOKIssue & { outside: true };

export function isScheduleCheckMismatch(
  issue: ScheduleCheckIssue,
): issue is ScheduleCheckMismatch {
  return issue.state === "ok" && issue.outside;
}

export interface ScheduleCheckRow extends ScheduleCheckItem {
  issues: ScheduleCheckIssue[];
  outside: boolean;
}

export interface ScheduleCheckSummary {
  items: number;
  pairs: number;
  checked: number;
  outsidePairs: number;
  outsideItems: number;
  skipped: number;
  errors: number;
  notFound: number;
  unchecked: number;
}

export interface ScheduleCheckProjection {
  rows: ScheduleCheckRow[];
  summary: ScheduleCheckSummary;
}

export type ScheduleCheckProblemKind =
  | "script"
  | "tracker"
  | "schedule"
  | "notFound";

export interface ScheduleCheckProblem {
  key: string;
  issue?: TrackerIssue;
  message?: string;
}

export interface ScheduleCheckReport {
  matchingIssues: number;
  matchingItems: number;
  skippedIssues: number;
  uncheckedIssues: number;
  problems: Record<ScheduleCheckProblemKind, ScheduleCheckProblem[]>;
}

export function scheduleCheckKeys(items: readonly ScheduleCheckItem[]): string[] {
  const keys = new Set<string>();
  for (const item of items) {
    for (const key of item.issueKeys) keys.add(key);
  }
  return [...keys];
}

// Period references use the same exact, case-sensitive labels as the schedule
// editor. A bad reference belongs to this issue; callers continue with the
// remaining extracted results.
export function resolveExtractedRange(
  range: ExtractedRange,
  periods: SchedulePeriod[],
): ResolvedRange {
  let { start, end } = range;
  if (range.startPeriod || range.endPeriod) {
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
  }
  if (start !== undefined && end !== undefined && start > end) {
    return { error: `Issue range starts after it ends (${start} > ${end})` };
  }
  return { start, end };
}

// projectScheduleCheck joins cached issue answers back to every item/issue
// pair. The same issue can fit one item and overhang another, so comparison is
// deliberately performed inside the item loop.
export function projectScheduleCheck(
  items: readonly ScheduleCheckItem[],
  results: readonly TrackerScheduleResult[],
  periods: SchedulePeriod[],
): ScheduleCheckProjection {
  const byKey = new Map(results.map((result) => [result.key, result]));
  const summary: ScheduleCheckSummary = {
    items: items.length,
    pairs: 0,
    checked: 0,
    outsidePairs: 0,
    outsideItems: 0,
    skipped: 0,
    errors: 0,
    notFound: 0,
    unchecked: 0,
  };
  const rows = items.map((item): ScheduleCheckRow => {
    const issues = item.issueKeys.map((key): ScheduleCheckIssue => {
      summary.pairs++;
      const result = byKey.get(key);
      if (!result) {
        summary.unchecked++;
        return { key, state: "unchecked", outside: false };
      }
      if (result.state === "ok") {
        const resolved = resolveExtractedRange(result, periods);
        if (resolved.error) {
          summary.errors++;
          return {
            ...result,
            state: "error",
            error: resolved.error,
            errorKind: "schedule",
            outside: false,
          };
        }
        const startOutside = resolved.start !== undefined && resolved.start < item.startDate;
        const endOutside = resolved.end !== undefined && resolved.end > item.endDate;
        const outside = startOutside || endOutside;
        summary.checked++;
        if (outside) summary.outsidePairs++;
        return { ...result, ...resolved, startOutside, endOutside, outside };
      }
      if (result.state === "skipped") summary.skipped++;
      else if (result.state === "error") summary.errors++;
      else if (result.state === "notFound") summary.notFound++;
      else summary.unchecked++;
      return { ...result, outside: false };
    });
    const outside = issues.some((issue) => issue.outside);
    if (outside) summary.outsideItems++;
    return { ...item, issues, outside };
  });
  return { rows, summary };
}

// reportScheduleCheck collapses pair-oriented comparison rows into the
// issue-oriented counts and problems shown around the discrepancy list.
export function reportScheduleCheck(
  projection: ScheduleCheckProjection,
): ScheduleCheckReport {
  const matchingKeys = new Set<string>();
  const matchingItems = new Set<number>();
  const skippedKeys = new Set<string>();
  const uncheckedKeys = new Set<string>();
  const problems: ScheduleCheckReport["problems"] = {
    script: [],
    tracker: [],
    schedule: [],
    notFound: [],
  };
  const problemKeys = new Set<string>();

  for (const row of projection.rows) {
    for (const issue of row.issues) {
      if (issue.state === "ok" && !issue.outside) {
        matchingKeys.add(issue.key);
        matchingItems.add(row.itemId);
      } else if (issue.state === "skipped") {
        skippedKeys.add(issue.key);
      } else if (issue.state === "unchecked") {
        uncheckedKeys.add(issue.key);
      } else if (issue.state === "error") {
        if (problemKeys.has(issue.key)) continue;
        problemKeys.add(issue.key);
        problems[issue.errorKind].push({
          key: issue.key,
          issue: issue.issue,
          message: issue.error,
        });
      } else if (issue.state === "notFound") {
        if (problemKeys.has(issue.key)) continue;
        problemKeys.add(issue.key);
        problems.notFound.push({ key: issue.key, issue: issue.issue });
      }
    }
  }
  return {
    matchingIssues: matchingKeys.size,
    matchingItems: matchingItems.size,
    skippedIssues: skippedKeys.size,
    uncheckedIssues: uncheckedKeys.size,
    problems,
  };
}
