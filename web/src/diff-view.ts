// Renders the version diff: what changed between the previewed snapshot
// (state.current, the before side) and the live roadmap (state.preview.compare,
// the after side). Entered from the snapshot banner's "Show changes"; active
// exactly while `preview.compare` is set (app.ts render()).
//
// Visually a sibling of the WBS outline — lanes stay lanes, entities are
// full-width rows — but it deliberately shares NO row classes with it or the
// timeline: wbs-dnd.ts and dnd.ts must stay structurally inert here (the same
// isolation rule the two chart views apply to each other). Every mutation is
// blocked during preview anyway; this makes the diff inert by construction,
// not by mode checks. Gesture-free furniture (wbs-chip) is shared, exactly
// like the builders the chart views share. The one row gesture is expanding a
// row's detail.
//
// A collapsed row only *names* what changed (an Added/Removed pill, field
// chips on modified rows); every old → new value lives in the detail. Only
// modified rows expand: an added or removed entity is its row — the version
// views don't show entity contents either (no edit panel in preview), so a
// diff drilling into them would show more than the versions themselves do.

import { laneColorValue } from "./colors";
import {
  diffCounts,
  diffRoadmaps,
  isEmptyDiff,
  type ChangeKind,
  type DepChange,
  type ItemDiff,
  type ItemField,
  type LaneDiff,
  type MilestoneDiff,
  type MilestoneField,
  type RoadmapDiff,
} from "./diff";
import { diffLines } from "./diff-text";
import { icons } from "./icons";
import { state } from "./state";
import { dayOf, formatDay } from "./timescale";
import type { DependencyRef, Item, Milestone, RoadmapFull } from "./types";

function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

// Expanded rows, keyed by entity kind + id. Module-local view state that
// survives re-renders, like history.ts toggledDays: stale keys never match, so
// it needs no reset when the snapshot or roadmap changes.
const expanded = new Set<string>();

function isoDate(iso: string): string {
  return formatDay(dayOf(iso));
}

function rangeText(it: Item): string {
  return `${isoDate(it.startDate)} – ${isoDate(it.endDate)}`;
}

// Titles and lane names resolved against one side of the diff, for the rows
// that reference other entities (dependency endpoints, a move's source lane, a
// nesting change's parent).
class SideIndex {
  private itemTitles = new Map<number, string>();
  private msTitles = new Map<number, string>();
  private laneNames = new Map<number, string>();

  constructor(rm: RoadmapFull) {
    for (const lane of rm.lanes) {
      this.laneNames.set(lane.id, lane.name);
      for (const top of lane.items) {
        this.itemTitles.set(top.id, top.title);
        for (const child of top.children) this.itemTitles.set(child.id, child.title);
      }
      for (const ms of lane.milestones) this.msTitles.set(ms.id, ms.title);
    }
  }

  lane(id: number): string {
    return this.laneNames.get(id) ?? `#${id}`;
  }

  item(id: number): string {
    return this.itemTitles.get(id) ?? `#${id}`;
  }

  ref(r: DependencyRef): string {
    return r.kind === "milestone" ? (this.msTitles.get(r.id) ?? `#${r.id}`) : this.item(r.id);
  }
}

let beforeIx: SideIndex;
let afterIx: SideIndex;

export function renderDiff(container: HTMLElement): void {
  const before = state.current;
  const after = state.preview?.compare;
  const scrollTop = container.scrollTop;
  container.replaceChildren();
  if (!before || !after) return; // render() only dispatches here when both exist

  beforeIx = new SideIndex(before);
  afterIx = new SideIndex(after);
  const d = diffRoadmaps(before, after);

  container.append(renderSummary(d));
  if (isEmptyDiff(d)) {
    container.scrollTop = scrollTop;
    return;
  }

  const lanesEl = div("lanes");
  for (const lane of d.lanes) lanesEl.append(renderLaneSection(lane));
  container.append(lanesEl);
  container.scrollTop = scrollTop;
}

// The summary strip: entity counts plus the roadmap-level changes that have no
// lane to live in (schedule, dependencies, context order).
function renderSummary(d: RoadmapDiff): HTMLElement {
  const el = div("diff-summary");

  if (isEmptyDiff(d)) {
    el.append(span("diff-summary-empty", "No changes — this version matches the current roadmap."));
    return el;
  }

  const counts = diffCounts(d);
  const head = div("diff-summary-counts");
  head.append(span("diff-summary-lead", "Changes since this version:"));
  if (counts.added > 0) head.append(span("diff-count diff-add", `+${counts.added} added`));
  if (counts.removed > 0) {
    head.append(span("diff-count diff-del", `−${counts.removed} removed`));
  }
  if (counts.modified > 0) head.append(span("diff-count", `${counts.modified} changed`));
  const laneNotes: string[] = [];
  if (d.laneOrderChanged) laneNotes.push("context order changed");
  const changedLanes = d.lanes.filter((l) => l.kind !== "unchanged").length;
  if (changedLanes > 0) {
    laneNotes.push(`${changedLanes} ${changedLanes === 1 ? "context" : "contexts"} changed`);
  }
  if (laneNotes.length > 0) head.append(span("diff-count", laneNotes.join(" · ")));
  el.append(head);

  // Deliberately not a period listing: replacing a pasted schedule touches
  // every row, and periods diff by value, so a list would name all of them.
  if (d.periodsAdded.length > 0 || d.periodsRemoved.length > 0) {
    const line = div("diff-summary-line");
    line.append(span("diff-summary-label", "Schedule"), span("diff-count", "changed"));
    el.append(line);
  }

  // Dependency changes render on their prerequisite's row; the summary only
  // counts them.
  if (d.depsAdded.length > 0 || d.depsRemoved.length > 0) {
    const line = div("diff-summary-line");
    line.append(span("diff-summary-label", "Dependencies"));
    if (d.depsAdded.length > 0) line.append(span("diff-count diff-add", `+${d.depsAdded.length}`));
    if (d.depsRemoved.length > 0) {
      line.append(span("diff-count diff-del", `−${d.depsRemoved.length}`));
    }
    el.append(line);
  }

  return el;
}

function renderLaneSection(lane: LaneDiff): HTMLElement {
  const laneEl = div("lane diff-lane");
  const l = lane.after ?? lane.before!;
  laneEl.style.setProperty("--c", laneColorValue(l.color));

  const label = div("lane-label diff-lane-label");
  label.append(span("diff-lane-name", l.name));
  const note = (text: string, cls = ""): HTMLElement => span(`diff-lane-note ${cls}`.trim(), text);
  if (lane.kind === "added") label.append(note("added", "diff-add"));
  if (lane.kind === "removed") label.append(note("removed", "diff-del"));
  if (lane.fields.includes("name")) label.append(note(`renamed from ${lane.before!.name}`));
  if (lane.fields.includes("color")) label.append(note("recolored"));
  // Which ranks moved is deliberately not shown — only that the order differs
  // (settled with the user; the exact permutation is noise).
  if (lane.orderChanged) label.append(note("items reordered"));

  const rows = div("diff-rows");
  for (const ms of lane.milestones) rows.append(...renderMilestone(ms));
  for (const entry of lane.items) rows.append(renderItemBlock(entry));

  laneEl.append(label, rows);
  return laneEl;
}

// Status pills mark the structural exceptions only: in a diff, "changed" is
// the norm — modified rows carry chips, not a badge. The tint derives from
// currentColor, so both variants are just the shared color utilities.
function pill(kind: ChangeKind): HTMLElement | null {
  if (kind === "added") return span("diff-pill diff-add", "Added");
  if (kind === "removed") return span("diff-pill diff-del", "Removed");
  return null;
}

// Human names for the changed-field chips on a collapsed row.
const FIELD_CHIPS: Record<ItemField, string> = {
  title: "title",
  description: "description",
  dates: "dates",
  priority: "priority",
  labels: "labels",
  flagged: "flagged",
  tentative: "tentative",
  atRisk: "at risk",
  lane: "moved",
  parent: "nesting",
  deps: "dependencies",
};

// The three booleans are events, not value pairs: their chip inlines the
// direction as a +/− prefix (no invented antonyms) and they get no detail row.
const BOOLEAN_FIELDS: ReadonlySet<ItemField> = new Set(["flagged", "tentative", "atRisk"]);

const MILESTONE_FIELD_CHIPS: Record<MilestoneField, string> = {
  title: "title",
  description: "description",
  date: "date",
  tentative: "tentative",
  integration: "integration milestone",
  lane: "moved",
  deps: "dependencies",
};

const MILESTONE_BOOLEAN_FIELDS: ReadonlySet<MilestoneField> = new Set([
  "tentative",
  "integration",
]);

function chipText(f: ItemField, a: Item): string {
  const name = FIELD_CHIPS[f];
  if (f === "flagged") return `${a.flagged ? "+" : "−"} ${name}`;
  if (f === "tentative") return `${a.tentative ? "+" : "−"} ${name}`;
  if (f === "atRisk") return `${a.atRisk ? "+" : "−"} ${name}`;
  return name;
}

function milestoneChipText(f: MilestoneField, a: Milestone): string {
  const name = MILESTONE_FIELD_CHIPS[f];
  if (f === "tentative") return `${a.tentative ? "+" : "−"} ${name}`;
  if (f === "integration") return `${a.linkage?.integration ? "+" : "−"} ${name}`;
  return name;
}

function renderItemBlock(entry: ItemDiff): HTMLElement {
  const block = div("diff-block");
  block.append(...renderItemRow(entry, false));
  for (const child of entry.children) block.append(...renderItemRow(child, true));
  return block;
}

// One item row plus, when expanded, its detail block. Returned together so a
// child's detail stays inside the parent's block, under the child's row.
function renderItemRow(entry: ItemDiff, isChild: boolean): HTMLElement[] {
  const it = (entry.after ?? entry.before)!;
  const key = `i${it.id}`;
  let cls = `diff-row diff-${entry.kind}`;
  if (isChild) cls += " diff-child";
  const row = div(cls);

  // Boolean flips live entirely in their chip, so a row changed only by them
  // has nothing left to unfold.
  const detail =
    entry.kind === "modified" && entry.fields.some((f) => !BOOLEAN_FIELDS.has(f));
  const lead = span("diff-disclosure", "");
  if (detail) lead.append(expanded.has(key) ? icons.chevronDown(11) : icons.chevronRight(11));
  row.append(lead, span("diff-title", it.title));
  const p = pill(entry.kind);
  if (p) row.append(p);

  if (entry.kind === "modified") {
    const chips = div("wbs-chips");
    for (const f of entry.fields) chips.append(span("wbs-chip", chipText(f, entry.after!)));
    row.append(chips);
  }

  // The current dates as plain context, like the WBS row's date column; a date
  // *change* is a "dates" chip whose old → new lives in the detail.
  row.append(span("diff-dates", rangeText(it)));

  const out = [row];
  if (detail) {
    row.classList.add("expandable");
    row.addEventListener("click", () => {
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      state.notify();
    });
    if (expanded.has(key)) {
      const detailEl = div(isChild ? "diff-detail diff-child" : "diff-detail");
      fillItemDetail(detailEl, entry);
      out.push(detailEl);
    }
  }
  return out;
}

// fieldRow is one "label: old → new" line in a detail block.
function fieldRow(label: string, before: string, after: string): HTMLElement {
  const el = div("diff-field");
  el.append(
    span("diff-field-label", label),
    span("diff-old", before),
    span("diff-arrow", "→"),
    span("diff-new", after),
  );
  return el;
}

function prioText(p: number | null): string {
  return p === null ? "—" : `P${p}`;
}

// depRows lists an entity's edge changes as one labeled row, edges flowing
// inline. The arrow keeps the app's prerequisite → dependent direction:
// "→ X" is an edge this entity enables, "← X" one that feeds it. Color alone
// carries add/remove; a +/− on top of it was punctuation soup.
function depRows(el: HTMLElement, entry: ItemDiff | MilestoneDiff): void {
  const row = div("diff-field");
  row.append(span("diff-field-label", "Dependencies"));
  const edge = (cls: string, c: DepChange, ix: SideIndex): HTMLElement =>
    span(cls, `${c.incoming ? "←" : "→"} ${ix.ref(c.other)}`);
  for (const c of entry.depsAdded) row.append(edge("diff-add", c, afterIx));
  for (const c of entry.depsRemoved) row.append(edge("diff-del", c, beforeIx));
  el.append(row);
}

// Only ever called for a modified entry — added/removed rows don't expand.
function fillItemDetail(el: HTMLElement, entry: ItemDiff): void {
  const b = entry.before!;
  const a = entry.after!;
  for (const f of entry.fields) {
    switch (f) {
      case "title":
        el.append(fieldRow("Title", b.title, a.title));
        break;
      case "dates":
        el.append(fieldRow("Dates", rangeText(b), rangeText(a)));
        break;
      case "priority":
        el.append(fieldRow("Priority", prioText(b.priority), prioText(a.priority)));
        break;
      case "labels": {
        // Not old-list → new-list: just the labels that came and went.
        const bSet = new Set(b.labels);
        const aSet = new Set(a.labels);
        const row = div("diff-field");
        row.append(span("diff-field-label", "Labels"));
        for (const l of a.labels.filter((x) => !bSet.has(x))) row.append(span("diff-add", `+ ${l}`));
        for (const l of b.labels.filter((x) => !aSet.has(x))) row.append(span("diff-del", `− ${l}`));
        el.append(row);
        break;
      }
      case "lane":
        el.append(fieldRow("Context", beforeIx.lane(b.laneId), afterIx.lane(a.laneId)));
        break;
      case "parent":
        el.append(
          fieldRow(
            "Parent",
            b.parentId === null ? "top level" : beforeIx.item(b.parentId),
            a.parentId === null ? "top level" : afterIx.item(a.parentId),
          ),
        );
        break;
      case "description":
        el.append(descDiff(b.description, a.description));
        break;
      case "deps":
        depRows(el, entry);
        break;
    }
  }
}

// The unified line diff for a description: a gutter glyph plus tinted line per
// op. Prose keeps the app font; only the gutter is monospace so its column
// aligns (styles.css).
function descDiff(before: string, after: string): HTMLElement {
  const el = div("diff-desc");
  const glyph = { same: " ", add: "+", del: "−" } as const;
  const tone = { same: "", add: " diff-add", del: " diff-del" } as const;
  for (const op of diffLines(before, after)) {
    const line = div(`diff-line diff-line-${op.kind}`);
    line.append(span(`diff-gutter${tone[op.kind]}`, glyph[op.kind]), span("diff-text", op.text));
    el.append(line);
  }
  return el;
}

function renderMilestone(entry: MilestoneDiff): HTMLElement[] {
  const ms = (entry.after ?? entry.before)!;
  const key = `m${ms.id}`;
  const row = div(`diff-row diff-ms diff-${entry.kind}`);

  // As for items, a boolean-only change is fully described by its signed chip
  // and must not offer an empty disclosure panel.
  const detail =
    entry.kind === "modified" && entry.fields.some((f) => !MILESTONE_BOOLEAN_FIELDS.has(f));
  const lead = span("diff-disclosure", "");
  if (detail) lead.append(expanded.has(key) ? icons.chevronDown(11) : icons.chevronRight(11));
  const title = span("diff-title", "");
  title.append(icons.milestone(10), document.createTextNode(ms.title));
  row.append(lead, title);
  const p = pill(entry.kind);
  if (p) row.append(p);

  if (entry.kind === "modified") {
    const chips = div("wbs-chips");
    for (const f of entry.fields) chips.append(span("wbs-chip", milestoneChipText(f, entry.after!)));
    row.append(chips);
  }

  row.append(span("diff-dates", isoDate(ms.date)));

  const out = [row];
  if (detail) {
    row.classList.add("expandable");
    row.addEventListener("click", () => {
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      state.notify();
    });
    if (expanded.has(key)) {
      const detailEl = div("diff-detail");
      const b = entry.before!;
      const a = entry.after!;
      if (entry.fields.includes("title")) detailEl.append(fieldRow("Title", b.title, a.title));
      if (entry.fields.includes("date")) {
        detailEl.append(fieldRow("Date", isoDate(b.date), isoDate(a.date)));
      }
      if (entry.fields.includes("lane")) {
        detailEl.append(fieldRow("Context", beforeIx.lane(b.laneId), afterIx.lane(a.laneId)));
      }
      if (entry.fields.includes("description")) {
        detailEl.append(descDiff(b.description, a.description));
      }
      if (entry.fields.includes("deps")) depRows(detailEl, entry);
      out.push(detailEl);
    }
  }
  return out;
}
