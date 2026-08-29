// Renders the WBS outline from the current state: the same model as the
// timeline chart with the time axis projected away. Lanes stay lanes (same
// .lane/.lane-label rail, so every label gesture works unchanged); items
// become uniform full-width rows, children indented
// inside their parent's block; milestones a small foldable group at the top
// of each lane. Rebuilt on every state change, like render.ts.
//
// The item rows deliberately share NO classes with the timeline's bars: each
// pointer controller must only ever see its own view's elements, so dnd.ts
// (which matches .bar/.child-bar) is structurally inert here rather than
// gated by a mode check. Row gestures — click, double-click, and the vertical
// reorder/nest/cross-lane drag — live in wbs-dnd.ts; milestone rows and the
// group fold stay on app.ts wireChart. The shared appearance lives in
// styles.css; the shared furniture builders (title, pill, flag, dependency
// mark, link, chevron) come from render.ts.

import { laneColorValue } from "./colors";
import { type DepSummary, refKey } from "./deps-graph";

import { icons } from "./icons";
import {
  barLink,
  barTitle,
  depMark,
  disclosure,
  emptyState,
  flagMark,
  linkageMark,
  laneLabel,
  prioPill,
  riskMark,
} from "./render";
import { periodPointText, periodRangeText } from "./schedule";
import { state } from "./state";
import { contentRange, dayOf, formatDay, spanFraction } from "./timescale";
import type { Item, ItemFull, LaneFull, Milestone } from "./types";

function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

// This pass's dependency summaries, rebuilt at the top of renderWbs. The
// timeline keeps its own (render.ts): the two views render independently, and
// depMark takes the entry rather than reading a shared global, so neither can
// draw from the other's pass.
let depSums = new Map<string, DepSummary>();

// The extent every date sparkline is measured against: the whole roadmap's
// occupied span, rebuilt at the top of renderWbs like depSums. Deliberately
// computed over ALL lanes, not the visible ones — a sparkline is only readable
// if the track means the same thing on every row, and hiding a lane must not
// silently rescale the rows that stayed. null when the roadmap holds nothing
// datable yet — which is also a roadmap with no rows to draw one on.
let extent: { startDay: number; endDay: number } | null = null;

export function renderWbs(container: HTMLElement): void {
  const rm = state.current;
  const scrollTop = container.scrollTop;
  container.replaceChildren();

  if (!rm) {
    container.append(emptyState());
    return;
  }

  depSums = state.dependencyAnalysis().summaries;
  extent = contentRange(rm.lanes);

  const lanesEl = div("lanes");
  const projection = state.projection();
  for (const lane of projection.lanes) {
    lanesEl.append(renderLaneSection(lane));
  }
  // Same hints as the timeline (render.ts) — the situations are identical.
  if (rm.lanes.length === 0) {
    const hint = div("lanes-hint");
    hint.textContent = "This roadmap has no contexts yet — add one below.";
    lanesEl.append(hint);
  } else if (projection.lanes.length === 0) {
    const hint = div("lanes-hint");
    hint.textContent = "All contexts are hidden — use the eye menu to show them.";
    lanesEl.append(hint);
  } else if (state.filter !== null && projection.drawnItemIds.size === 0) {
    const hint = div("lanes-hint");
    hint.textContent = "No items match this filter — use the filter menu to change or clear it.";
    lanesEl.append(hint);
  }

  const addRow = div("lane-add-row");
  const addBtn = document.createElement("button");
  addBtn.className = "btn btn-ghost";
  addBtn.id = "add-lane";
  addBtn.textContent = "+ Add context";
  addRow.append(addBtn);

  container.append(lanesEl, addRow);

  const selectedEl = state.scrollToSelection
    ? container.querySelector<HTMLElement>(".wbs-row.selected, .wbs-milestone.selected")
    : null;
  if (state.scrollToSelection && selectedEl) {
    state.scrollToSelection = false;
    selectedEl.scrollIntoView({ block: "center" });
  } else {
    container.scrollTop = scrollTop;
  }
  // scrollToToday is deliberately left set: it has no meaning without a time
  // axis, and the first switch back to the timeline should still honour it.
}

// projectWbsSelection is the WBS twin of render.ts projectSelection — the
// subscriber side of state.notifySelection while this view is active. Same
// honesty rule: recompute the predicate for EVERY element from state.
export function projectWbsSelection(container: HTMLElement): void {
  for (const el of container.querySelectorAll<HTMLElement>(".wbs-row")) {
    el.classList.toggle("selected", state.isItemSelected(Number(el.dataset.itemId)));
  }
  for (const el of container.querySelectorAll<HTMLElement>(".wbs-milestone")) {
    el.classList.toggle("selected", state.selectedMilestoneId === Number(el.dataset.milestoneId));
  }
}

function renderLaneSection(lane: LaneFull): HTMLElement {
  const laneEl = div("lane");
  laneEl.dataset.laneId = String(lane.id);
  laneEl.style.setProperty("--c", laneColorValue(lane.color));

  const rows = div("wbs-rows");
  if (lane.milestones.length > 0) rows.append(...renderMilestoneGroup(lane));
  for (const item of lane.items) rows.append(renderItemBlock(item)); // lane is projected

  laneEl.append(laneLabel(lane), rows);
  return laneEl;
}

// The milestone group: a fold header plus, when unfolded, one selectable row
// per milestone. The header wears subheader styling on purpose, NOT the item
// row language — it has no id, no dates, and answers no item gesture, so it
// must not invite them; only the fold chevron is borrowed. Milestones are
// date-sorted by the model and have no rank, so their rows never reorder —
// the date on each row is what explains the order.
function renderMilestoneGroup(lane: LaneFull): HTMLElement[] {
  const collapsed = state.isMilestonesCollapsed(lane.id);
  const head = document.createElement("button");
  head.className = "wbs-ms-head";
  head.dataset.laneId = String(lane.id);
  head.title = collapsed ? "Show milestones" : "Hide milestones";
  const chevron = document.createElement("span");
  chevron.className = "wbs-ms-chevron";
  chevron.append(collapsed ? icons.chevronRight(11) : icons.chevronDown(11));
  const label = document.createElement("span");
  // The count when folded: things folded away should announce their number
  // (the flaggedCount rule — what nobody can see never gets dealt with).
  label.textContent = collapsed ? `Milestones (${lane.milestones.length})` : "Milestones";
  head.append(chevron, label);

  const out: HTMLElement[] = [head];
  if (!collapsed) for (const m of lane.milestones) out.push(renderMilestoneRow(m));
  return out;
}

// The column's date form, as a function of the ISO string the schedule helpers
// hand back, so an unaligned edge prints exactly what it printed before.
function isoDate(iso: string): string {
  return formatDay(dayOf(iso));
}

function renderMilestoneRow(m: Milestone): HTMLElement {
  // Never removed by the filter, as in the timeline (see render.ts).
  let className = state.selectedMilestoneId === m.id ? "wbs-milestone selected" : "wbs-milestone";
  if (m.tentative) className += " tentative";
  const el = div(className);
  el.dataset.milestoneId = String(m.id);
  const title = div("wbs-ms-title");
  title.textContent = m.title;
  const date = div("wbs-dates");
  // The WBS uses the same textual tentative mark for both entity kinds; the
  // hollow diamond remains the milestone's shape cue.
  const approx = m.tentative ? "≈ " : "";
  date.textContent = approx + periodPointText(state.current?.periods ?? [], m.date, isoDate);
  // The same mark carries both dependency presence and conflict in each view;
  // the WBS keeps it with the row's trailing furniture.
  el.append(
    div("wbs-ms-diamond"),
    title,
    linkageMark(m),
    depMark(depSums.get(refKey({ kind: "milestone", id: m.id }))),
    date,
  );
  return el;
}

// renderItemBlock builds a top-level item's rows: the parent row plus, unless
// folded, one indented row per child — the same containment the timeline
// draws, with the block's color spine bracketing the family.
function renderItemBlock(item: ItemFull): HTMLElement {
  const hasChildren = item.children.length > 0;
  const collapsed = hasChildren && state.rendersCollapsed(item.id);
  const block = div(hasChildren ? "wbs-block has-children" : "wbs-block");
  block.dataset.itemId = String(item.id); // wbs-dnd.ts resolves drop targets by it
  block.append(
    renderRow(item, hasChildren && state.filter === null ? disclosure(item, collapsed) : null, false),
  );
  if (!collapsed) for (const c of item.children) block.append(renderRow(c, null, true));
  return block;
}

// renderRow builds one item row in the timeline's bar language minus what
// encodes time: uniform width, no resize handles, and the dates as muted text
// — the feedback channel for panel edits, and the reminder that the item
// still lives on a calendar. The full width buys what a bar never had room
// for: the item's labels, visible as chips.
function renderRow(item: Item, lead: HTMLElement | null, isChild: boolean): HTMLElement {
  let cls = isChild ? "wbs-row wbs-child" : "wbs-row";
  if (state.isItemSelected(item.id)) cls += " selected";
  const row = div(cls);
  if (state.filter !== null) row.classList.add("move-disabled");
  if (!state.matchesFilter(item)) row.classList.add("dimmed");
  row.dataset.itemId = String(item.id);
  if (lead) row.append(lead);
  const main = div("wbs-main");
  main.append(barTitle(item.title), barLink(item.description));
  row.append(main);
  if (item.labels.length > 0) {
    const chips = div("wbs-chips");
    for (const l of item.labels) {
      const chip = document.createElement("span");
      chip.className = "wbs-chip";
      chip.textContent = l;
      chips.append(chip);
    }
    row.append(chips);
  }
  const dates = div("wbs-dates has-spark");
  // Tentative timing: a compact "≈" ahead of the range — the timeline's
  // sawtooth silhouette does not translate to a row, the prefix does.
  const approx = item.tentative ? "≈ " : "";
  // With a schedule defined the range is named by the periods it occupies
  // rather than by its dates, the WBS being about structure more than about
  // exact timing; the separator says whether it fills them (schedule.ts).
  dates.textContent =
    approx + periodRangeText(state.current?.periods ?? [], item.startDate, item.endDate, isoDate);
  // The sparkline gives back the one thing the outline throws away: *where* a
  // range lies. A track of its own, not a tint behind the dates — that was
  // tried, and a fill crossing the text reads as a highlight on whichever words
  // it covers, with short items landing as a dash mid-date. Milestones get no
  // track: a point has no span, and a dot would invite comparison with the bars.
  const spark = div("wbs-spark");
  const fill = div("wbs-spark-fill");
  // extent! — contentRange is null only for a roadmap with nothing datable in
  // it, which is a roadmap with no rows to reach this line from.
  const f = spanFraction(dayOf(item.startDate), dayOf(item.endDate), extent!);
  fill.style.left = `${f.left * 100}%`;
  fill.style.width = `${f.width * 100}%`;
  spark.append(fill);
  // Dates and track come last, not pill/flag-outermost as on a bar: every row's
  // range then shares the right edge, and both read as columns — pill and chip
  // widths vary row to row, so anything of *variable* width trailing the dates
  // would make the column ragged.
  row.append(
    prioPill(item.priority),
    depMark(depSums.get(refKey({ kind: "item", id: item.id }))),
    riskMark(item.atRisk),
    flagMark(item.flagged),
    dates,
    spark,
  );
  return row;
}
