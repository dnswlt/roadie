// Pure reconciliation between tracker results and Roadie items. The tracker
// supplies each issue's canonical URL, which makes it the authority for the
// configured deployment (host and any context path): a lookalike /browse/ URL
// on another host, or under another Jira installation on the same host, never
// becomes a match.

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
