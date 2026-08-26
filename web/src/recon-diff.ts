// Pure reconciliation between tracker results and Roadie items. One rule
// throughout: a link belongs to this tracker when it sits under the configured
// deployment (host and any context path), so a lookalike /browse/ URL on
// another host, or under another Jira installation on the same host, is not a
// reference. Issue matching reads that deployment off the issue's own canonical
// URL; the Roadie-side list, which has no issue in hand, reads it off
// state.me.trackerUrl.

import { extractLinks } from "./links";
import type { RoadmapFull, TrackerIssue } from "./types";

export interface RoadieIssueMatch {
  itemId: number;
  title: string;
  laneColor: string;
}

export interface ReconciledIssue {
  issue: TrackerIssue;
  matches: RoadieIssueMatch[];
}

export interface UnreferencedRoadieItem {
  itemId: number;
  title: string;
  laneName: string;
  laneColor: string;
  parentTitle: string | null;
}

export interface ScheduleCheckItem {
  itemId: number;
  title: string;
  laneName: string;
  laneColor: string;
  parentTitle: string | null;
  startDate: string;
  endDate: string;
  issueKeys: string[];
}

export interface RoadieJiraProjection {
  unreferencedItems: UnreferencedRoadieItem[];
  scheduleItems: ScheduleCheckItem[];
}

// Jira's default issue-key grammar. The key is normalized separately from the
// rest of the URL because Jira keys are case-insensitive while a deployment's
// context path need not be.
const ISSUE_PATH = /^(.*\/browse\/)([a-z][a-z0-9_]*-[1-9][0-9]*)\/?$/i;

function issueIdentity(raw: string, expectedKey?: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const match = url.pathname.match(ISSUE_PATH);
    if (!match) return null;
    const key = match[2]!;
    if (expectedKey !== undefined && key.toLowerCase() !== expectedKey.toLowerCase()) return null;
    // Search and fragment commonly carry a selected tab/comment, not identity.
    return `${url.origin}${match[1]}${key.toUpperCase()}`;
  } catch {
    return null;
  }
}

// Every issue link under a deployment starts with this prefix, which is what
// makes it comparable against a link's identity. The URL goes through URL()
// rather than being concatenated, so a configured host in mixed case still
// matches the lowercased origin a parsed link yields.
function browsePrefix(trackerUrl: string): string {
  const base = new URL(trackerUrl);
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}/browse/`;
}

function jiraIssueKeys(description: string, prefix: string): string[] {
  const keys = new Set<string>();
  for (const link of extractLinks(description)) {
    const identity = issueIdentity(link.url);
    if (identity?.startsWith(prefix)) keys.add(identity.slice(prefix.length));
  }
  return [...keys];
}

// projectRoadieJiraLinks answers both Roadie-side questions in one traversal.
// It follows roadmap order and de-duplicates repeated spellings of an issue
// link within one item; the same issue under another item remains another pair.
// Milestones never enter the traversal.
export function projectRoadieJiraLinks(
  roadmap: RoadmapFull | null,
  trackerUrl: string,
): RoadieJiraProjection {
  const projection: RoadieJiraProjection = {
    unreferencedItems: [],
    scheduleItems: [],
  };
  if (!roadmap) return projection;
  const prefix = browsePrefix(trackerUrl);
  for (const lane of roadmap.lanes) {
    for (const top of lane.items) {
      for (const item of [top, ...top.children]) {
        const issueKeys = jiraIssueKeys(item.description, prefix);
        const parentTitle = item.parentId === null ? null : top.title;
        if (issueKeys.length === 0) {
          projection.unreferencedItems.push({
            itemId: item.id,
            title: item.title,
            laneName: lane.name,
            laneColor: lane.color,
            parentTitle,
          });
        } else {
          projection.scheduleItems.push({
            itemId: item.id,
            title: item.title,
            laneName: lane.name,
            laneColor: lane.color,
            parentTitle,
            startDate: item.startDate,
            endDate: item.endDate,
            issueKeys,
          });
        }
      }
    }
  }
  return projection;
}

// diffTrackerIssues preserves Jira result order and roadmap order. Several
// items may match one issue, and one item may be added to several issue rows.
// Duplicate spellings of one normalized URL inside an item still yield one
// match. Milestones deliberately never enter this traversal (notes/JIRA.md).
export function diffTrackerIssues(
  issues: readonly TrackerIssue[],
  roadmap: RoadmapFull | null,
): ReconciledIssue[] {
  const rows = issues.map((issue) => ({ issue, matches: [] as RoadieIssueMatch[] }));
  if (!roadmap || rows.length === 0) return rows;

  const rowsByIdentity = new Map<string, ReconciledIssue[]>();
  for (const row of rows) {
    const identity = issueIdentity(row.issue.url, row.issue.key);
    if (!identity) continue;
    const sameIssue = rowsByIdentity.get(identity);
    if (sameIssue) sameIssue.push(row);
    else rowsByIdentity.set(identity, [row]);
  }

  for (const lane of roadmap.lanes) {
    for (const top of lane.items) {
      for (const item of [top, ...top.children]) {
        const matchedRows = new Set<ReconciledIssue>();
        for (const link of extractLinks(item.description)) {
          const identity = issueIdentity(link.url);
          if (!identity) continue;
          for (const row of rowsByIdentity.get(identity) ?? []) matchedRows.add(row);
        }
        const match = { itemId: item.id, title: item.title, laneColor: lane.color };
        for (const row of matchedRows) row.matches.push(match);
      }
    }
  }

  return rows;
}
