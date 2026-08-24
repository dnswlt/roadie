// Renders roadmap data as Markdown for the clipboard — the chart is the one
// thing you cannot paste into a chat, an issue, or a prompt.
//
// Headings rather than nested bullets, so descriptions are emitted verbatim at
// column 0. Indenting them into list items would rewrite the author's text, and
// anything whitespace-sensitive — a fenced block, a table — is at the mercy of
// that. The depth maps exactly and cannot overflow: roadmap h1, lane h2, item
// h3, child h4, with nesting capped at one level by the store.
//
// DOM-free so markdown.test.ts can pin the format. Whichever scope you copy, the
// result names where it came from, so a fragment is not an orphan.

import { dayOf } from "./timescale";
import type { Item, ItemFull, LaneFull, Milestone, RoadmapFull, SchedulePeriod } from "./types";

// A lane or a whole roadmap is a plan that keeps moving, so a copy of one is
// only true as of a moment. `now` is a parameter rather than read here so the
// output stays pinnable by a test. Local time: it is for whoever pasted it.
function stamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `Copied ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

// Durations are spelled out rather than left to be inferred: Roadie's dates are
// inclusive, and a reader computing 2027-04-05 → 2027-04-05 as zero days would
// be wrong.
function days(startDate: string, endDate: string): string {
  const n = dayOf(endDate) - dayOf(startDate) + 1;
  return n === 1 ? "1 day" : `${n} days`;
}

// metaLine is the italic line under an entry's heading: dates, duration, then
// priority / warning marks / labels when set — one "·" separator throughout, so
// the line reads as one quiet run rather than a mix of parens and dashes.
// Tentative timing prefixes the date range with "≈", as in the WBS; at risk is
// "⚠" beside the flag's "⚑".
//
// The heading carries the title and nothing else. Dates in a heading render as
// giant bold noise the moment the copy is published for humans, and a title
// drowning in its own metadata was exactly the "number salad" this replaces.
// The metadata sits on the very next line, no blank between — CommonMark lets a
// paragraph follow an ATX heading directly — so a bare item costs three lines,
// not four. Italic keeps it visually subordinate and, more usefully,
// distinguishes it from the first line of a description, which is also just a
// paragraph.
function metaLine(item: Item): string {
  const parts = [
    `${item.tentative ? "≈ " : ""}${item.startDate} → ${item.endDate}`,
    days(item.startDate, item.endDate),
  ];
  if (item.priority !== null) parts.push(`P${item.priority}`);
  if (item.atRisk) parts.push("⚠");
  if (item.flagged) parts.push("⚑");
  if (item.labels.length > 0) parts.push(item.labels.join(", "));
  return `*${parts.join(" · ")}*`;
}

function itemBlock(item: Item, level: number): string[] {
  const lines = [`${"#".repeat(level)} ${item.title}`, metaLine(item), ""];
  if (item.description.trim().length > 0) lines.push(item.description.trim(), "");
  for (const child of (item as ItemFull).children ?? []) {
    lines.push(...itemBlock(child, level + 1));
  }
  return lines;
}

// Milestones are one section per lane, not one heading each: a milestone is a
// title and a date, and a handful of them as full document sections outweighed
// the items they were mere markers for. The section heading also does the job
// the ◇ glyph used to do. A description (rare) is indented under its bullet —
// the verbatim-at-column-0 rule is worth its cost for items, whose descriptions
// are the long-form content, not for a marker's side note.
function milestonesBlock(milestones: Milestone[]): string[] {
  if (milestones.length === 0) return [];
  const lines = ["### Milestones", ""];
  for (const ms of milestones) {
    lines.push(`- **${ms.title}** — ${ms.tentative ? "≈ " : ""}${ms.date}`);
    const desc = ms.description.trim();
    if (desc.length > 0) {
      lines.push("", ...desc.split("\n").map((l) => (l.length > 0 ? `  ${l}` : "")), "");
    }
  }
  if (lines[lines.length - 1] !== "") lines.push("");
  return lines;
}

// A lane's milestones come first: they are the dates the items are working
// towards, which is the context you want before reading the work.
function laneBlock(lane: LaneFull): string[] {
  const lines = [`## ${lane.name}`, ""];
  if (lane.milestones.length === 0 && lane.items.length === 0) {
    lines.push("_No items._", "");
    return lines;
  }
  lines.push(...milestonesBlock(lane.milestones));
  for (const item of lane.items) lines.push(...itemBlock(item, 3));
  return lines;
}

// The schedule stays a list: its periods are rows of data, not sections.
function scheduleLines(periods: SchedulePeriod[]): string[] {
  if (periods.length === 0) return [];
  return [
    "**Schedule**",
    "",
    ...periods.map((p) => `- ${p.label} — ${p.startDate} → ${p.endDate}`),
    "",
  ];
}

export function roadmapMarkdown(roadmap: RoadmapFull, now = new Date()): string {
  return [
    `# ${roadmap.name}`,
    "",
    stamp(now),
    "",
    ...scheduleLines(roadmap.periods),
    ...roadmap.lanes.flatMap(laneBlock),
  ]
    .join("\n")
    .trimEnd();
}

export function laneMarkdown(roadmap: RoadmapFull, lane: LaneFull, now = new Date()): string {
  return [`# ${roadmap.name}`, "", stamp(now), "", ...laneBlock(lane)].join("\n").trimEnd();
}

// A single item, at the same heading levels it has in the full export — lane
// h2, item h3, child h4 with its parent as a bare h3 above it — so a fragment
// reads as a cut-out of the whole document, not a re-formatting of it. The
// parent heading carries no meta line: it is context naming where the child
// sits, and its dates were not what was copied. No timestamp either: one item
// is a thing you are talking about, not a plan whose shape will have moved on.
export function itemMarkdown(
  roadmap: RoadmapFull,
  lane: LaneFull,
  item: Item,
  parent: ItemFull | null,
): string {
  const lines = [`# ${roadmap.name}`, "", `## ${lane.name}`, ""];
  if (parent) lines.push(`### ${parent.title}`, "");
  lines.push(...itemBlock(item, parent ? 4 : 3));
  return lines.join("\n").trimEnd();
}
