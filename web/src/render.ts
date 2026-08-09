// Renders the swimlane chart from the current state. The chart is rebuilt
// on every state change; scroll position is preserved across rebuilds.

import { laneColorValue } from "./colors";
import { type DepSummary, depSummaries, refKey } from "./deps-graph";
import { icons } from "./icons";
import { LABEL_W, PARENT_BAR_H, layoutLane, type PlacedBlock } from "./layout";
import { extractUrls } from "./links";
import { scheduleBounds } from "./schedule";
import { state } from "./state";
import {
  chartWidth,
  computeRange,
  dayOf,
  formatDay,
  monthTicks,
  quarterTicks,
  todayDay,
  xOf,
  type Scale,
} from "./timescale";
import type { Item, ItemFull, LaneFull, Milestone, SchedulePeriod } from "./types";

let scale: Scale = { startDay: 0, endDay: 0, pxPerDay: 3 };

// The dependency summaries backing this pass's marks, rebuilt at the top of
// renderChart — same lifecycle as `scale`, and for the same reason: it is
// derived from the state the pass is drawing, and every reader below is
// reached from that pass. The WBS builds its own (wbs.ts); depMark itself
// takes the entry, so neither view can read the other's.
let depSums = new Map<string, DepSummary>();

// depsOf looks up an item's summary for this pass. Undefined = no edges.
function depsOf(item: Item): DepSummary | undefined {
  return depSums.get(refKey({ kind: "item", id: item.id }));
}

export function currentScale(): Scale {
  return scale;
}

function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

export function renderChart(container: HTMLElement): void {
  const rm = state.current;
  const today = todayDay();
  const range = computeRange(rm, today);
  scale = { ...range, pxPerDay: state.pxPerDay };

  depSums = depSummaries(rm);

  const scrollLeft = container.scrollLeft;
  const scrollTop = container.scrollTop;
  container.replaceChildren();

  if (!rm) {
    container.append(emptyState());
    return;
  }

  const w = chartWidth(scale);
  const grid = div("grid");
  grid.style.width = `${LABEL_W + w}px`;

  // Time axis header. Two rows: a coarse top row + the months row. When the
  // roadmap defines a schedule, its period band replaces the quarter row (and
  // the months then carry the year, since the quarter row otherwise owns it).
  const hasSchedule = rm.periods.length > 0;
  const thead = div("thead");
  const corner = div("corner");
  corner.textContent = "Contexts";
  const thRows = div("th-rows");
  thRows.style.width = `${w}px`;

  const topRow = hasSchedule ? renderScheduleRow(rm.periods) : renderQuarterRow();
  const mRow = div("th-row th-months");
  for (const t of monthTicks(scale, hasSchedule)) {
    const cell = div("th-cell");
    const cw = t.days * scale.pxPerDay;
    cell.style.width = `${cw}px`;
    cell.textContent = cw >= 34 ? t.label : "";
    mRow.append(cell);
  }
  // Today: a small triangle at the bottom edge of the time header.
  const tx = xOf(scale, today);
  if (tx >= 0 && tx <= w) {
    const marker = div("today-marker");
    marker.style.left = `${tx}px`;
    marker.title = "Today";
    thRows.append(marker);
  }
  thRows.append(topRow, mRow);
  thead.append(corner, thRows);

  // Lanes (hidden ones are skipped — see the eye menu in the topbar).
  const lanesEl = div("lanes");
  const visibleLanes = rm.lanes.filter((l) => !state.isLaneHidden(l.id));
  for (const lane of visibleLanes) {
    lanesEl.append(renderLane(lane, w));
  }
  if (rm.lanes.length === 0) {
    const hint = div("lanes-hint");
    hint.textContent = "This roadmap has no contexts yet — add one below.";
    lanesEl.append(hint);
  } else if (visibleLanes.length === 0) {
    const hint = div("lanes-hint");
    hint.textContent = "All contexts are hidden — use the eye menu to show them.";
    lanesEl.append(hint);
  }

  // Add-lane row.
  const addRow = div("lane-add-row");
  const addBtn = document.createElement("button");
  addBtn.className = "btn btn-ghost";
  addBtn.id = "add-lane";
  addBtn.textContent = "+ Add context";
  addRow.append(addBtn);

  grid.append(thead, lanesEl, addRow);
  container.append(grid);

  const selectedEl = state.scrollToSelection
    ? container.querySelector<HTMLElement>(".block.selected, .child-bar.selected, .milestone.selected")
    : null;
  if (state.scrollToSelection && selectedEl) {
    state.scrollToSelection = false;
    state.scrollToToday = false;
    selectedEl.scrollIntoView({ block: "center", inline: "center" });
  } else if (state.scrollToToday) {
    state.scrollToSelection = false;
    state.scrollToToday = false;
    container.scrollLeft = Math.max(0, LABEL_W + tx - container.clientWidth / 2);
    container.scrollTop = 0;
  } else {
    container.scrollLeft = scrollLeft;
    container.scrollTop = scrollTop;
  }
}

// emptyState builds the no-roadmap-yet notice with its create button (wired
// in app.ts by id). Shared with the WBS view (wbs.ts).
export function emptyState(): HTMLElement {
  const empty = div("empty-state");
  const msg = div("empty-msg");
  msg.textContent = "No roadmap yet.";
  const btn = document.createElement("button");
  btn.className = "btn btn-primary";
  btn.id = "empty-create";
  btn.textContent = "Create your first roadmap";
  empty.append(msg, btn);
  return empty;
}

// projectSelection stamps the current selection onto the already-rendered
// chart — the subscriber side of state.notifySelection (rationale in
// CLAUDE.md: selection changes no geometry, and click gestures need the DOM
// nodes to survive). The honesty rule: recompute the predicate for EVERY
// element from state, never patch only the nodes assumed to have changed —
// so a stale .selected is as impossible as it is under a full rebuild.
export function projectSelection(container: HTMLElement): void {
  for (const el of container.querySelectorAll<HTMLElement>(".block, .child-bar")) {
    el.classList.toggle("selected", state.isItemSelected(Number(el.dataset.itemId)));
  }
  for (const el of container.querySelectorAll<HTMLElement>(".milestone")) {
    el.classList.toggle("selected", state.selectedMilestoneId === Number(el.dataset.milestoneId));
  }
}

// SCHEDULE_LABEL_PX: hide a period's label below this width, like the months
// row — the boundaries still show, so the rhythm reads; the full label is on the
// span's title. Slightly wider than the months threshold since it centers.
const SCHEDULE_LABEL_PX = 40;

// renderQuarterRow builds the default coarse header row: contiguous quarter
// cells (Q1 2026, ...), the sole place the year appears when there's no schedule.
function renderQuarterRow(): HTMLElement {
  const row = div("th-row th-quarters");
  for (const t of quarterTicks(scale)) {
    const cell = div("th-cell");
    cell.style.width = `${t.days * scale.pxPerDay}px`;
    cell.textContent = t.days * scale.pxPerDay >= 44 ? t.label : "";
    row.append(cell);
  }
  return row;
}

// renderScheduleRow builds the schedule band that replaces the quarter row when
// a schedule is defined. Unlike quarters/months it does not tile the axis:
// periods are sparse (gaps are real, and they need not align to the chart edge),
// so each is an absolutely-positioned span; a bar owns [xOf(start), xOf(end+1)).
function renderScheduleRow(periods: SchedulePeriod[]): HTMLElement {
  const row = div("th-row th-schedule");
  // Alternating fills (zebra) so adjacent periods — which touch with no gap —
  // read as distinct. Periods arrive ordered by start date, so index parity is
  // chronological parity.
  periods.forEach((p, i) => {
    const left = xOf(scale, dayOf(p.startDate));
    const width = xOf(scale, dayOf(p.endDate) + 1) - left;
    const span = div(i % 2 === 1 ? "th-period th-period-alt" : "th-period");
    span.style.left = `${left}px`;
    span.style.width = `${width}px`;
    // Tooltip carries the dates (end inclusive) too — useful when the label is
    // hidden on a narrow period, and to read a period's span without measuring.
    span.title = `${p.label}\n${formatDay(dayOf(p.startDate))} – ${formatDay(dayOf(p.endDate))}`;
    if (width >= SCHEDULE_LABEL_PX) span.textContent = p.label;
    row.append(span);
  });
  return row;
}

// laneLabel builds a lane's sticky label column: grip, name, hover actions.
// Shared with the WBS view (wbs.ts), which renders the same rail — every
// label gesture (rename, the lane menu, reorder by grip) is view-independent,
// so both views reuse the .lane/.lane-label classes and the handlers wired to
// them (app.ts wireChart, dnd.ts lane drag).
export function laneLabel(lane: LaneFull): HTMLElement {
  const label = div("lane-label");
  const grip = document.createElement("button");
  grip.className = "lane-grip";
  grip.title = "Drag to reorder";
  grip.append(icons.grip());
  const name = document.createElement("span");
  name.className = "lane-name";
  name.textContent = lane.name;
  name.title = "Double-click to rename";
  const laneActions = div("lane-actions");
  const add = document.createElement("button");
  add.className = "icon-btn lane-add";
  add.title = "Add item";
  add.append(icons.plus(14));
  const menu = document.createElement("button");
  menu.className = "icon-btn lane-menu-btn";
  menu.title = "More actions";
  menu.append(icons.dots(16));
  laneActions.append(add, menu);
  label.append(grip, name, laneActions);
  return label;
}

function renderLane(lane: LaneFull, chartW: number): HTMLElement {
  const layout = layoutLane(lane, scale, (id) => state.isCollapsed(id));
  const laneEl = div("lane");
  laneEl.dataset.laneId = String(lane.id);
  laneEl.style.setProperty("--c", laneColorValue(lane.color));

  const canvas = div("lane-canvas");
  canvas.style.width = `${chartW}px`;
  canvas.style.height = `${layout.height}px`;

  // Month gridlines. Normally the quarter starts are drawn slightly stronger;
  // when a schedule is active its period boundaries take that emphasis instead
  // (added below), so the whole board aligns to the planning rhythm.
  const periods = state.current?.periods ?? [];
  const hasSchedule = periods.length > 0;
  for (const t of monthTicks(scale)) {
    const d = new Date(t.day * 86_400_000);
    const strong = !hasSchedule && d.getUTCDate() === 1 && d.getUTCMonth() % 3 === 0;
    const gl = div(strong ? "gl gl-q" : "gl");
    gl.style.left = `${xOf(scale, t.day)}px`;
    canvas.append(gl);
  }
  for (const b of scheduleBounds(periods)) {
    const gl = div("gl gl-q");
    gl.style.left = `${xOf(scale, b)}px`;
    canvas.append(gl);
  }

  // Milestone drop-lines go in behind the bars (appended before the blocks, so
  // items paint over and hide them); the diamonds go on top afterwards.
  for (const m of lane.milestones) {
    canvas.append(renderMilestoneLine(m));
  }

  for (const block of layout.blocks) {
    canvas.append(renderBlock(block));
  }

  // Milestone diamonds live in a reserved band at the lane top. Each carries
  // its title to the right of its diamond, budgeted to the space before the
  // next milestone (the model keeps them date-sorted); when even a sliver
  // won't fit, the label stays hidden and hover/selection reveals it instead.
  lane.milestones.forEach((m, i) => {
    const next = lane.milestones[i + 1];
    const limit = next ? xOf(scale, dayOf(next.date)) - MS_LABEL_CLEAR : chartW - 4;
    canvas.append(renderMilestone(m, limit - (xOf(scale, dayOf(m.date)) + MS_LABEL_LEFT)));
  });

  laneEl.append(laneLabel(lane), canvas);
  return laneEl;
}

function renderMilestoneLine(m: Milestone): HTMLElement {
  const line = div("milestone-line");
  // Milestones carry neither labels nor a flag, so any active focus dims them.
  if (state.focus !== null) line.classList.add("dimmed");
  line.style.left = `${xOf(scale, dayOf(m.date))}px`;
  return line;
}

// Geometry of the band label, mirrored by .milestone-label in styles.css: its
// left edge sits MS_LABEL_LEFT px right of the diamond's center (the 13px
// diamond box plus a 6px gap, minus half the box); MS_LABEL_CLEAR keeps it
// short of the next milestone's drop-line and diamond tip; below MS_LABEL_MIN
// px of room the label is hidden rather than ellipsized down to nothing.
const MS_LABEL_LEFT = 12.5;
const MS_LABEL_CLEAR = 14;
const MS_LABEL_MIN = 24;

// renderMilestone builds a diamond plus its band label. `labelPx` is the
// horizontal room the label may use: enough gets an ellipsized always-visible
// title, less gets a hidden one that hover/selection reveals as a chip painted
// over the neighbors (which also replaces the old native title tooltip — too
// slow to be useful, and it would double up with the reveal). The budget rides
// in a CSS custom property rather than an inline max-width so the stylesheet's
// hover/selected rules can override it without !important.
function renderMilestone(m: Milestone, labelPx: number): HTMLElement {
  const el = div(state.selectedMilestoneId === m.id ? "milestone selected" : "milestone");
  // Milestones carry neither labels nor a flag, so any active focus dims them.
  if (state.focus !== null) el.classList.add("dimmed");
  // A milestone has no furniture run to hold the dependency mark — it is a
  // diamond and an absolutely-positioned label — so it carries the warning on
  // the diamond itself. Only the warning: "has edges" has nowhere to go here,
  // and is a click ("d") away, while "cannot be met as scheduled" is the thing
  // that must not wait to be asked for.
  if ((depSums.get(refKey({ kind: "milestone", id: m.id }))?.conflicts ?? 0) > 0) {
    el.classList.add("dep-conflict");
  }
  el.dataset.milestoneId = String(m.id);
  el.style.left = `${xOf(scale, dayOf(m.date))}px`;
  const label = div("milestone-label");
  label.textContent = m.title;
  if (labelPx < MS_LABEL_MIN) label.classList.add("cramped");
  else label.style.setProperty("--avail", `${labelPx}px`);
  el.append(div("milestone-diamond"), label);
  return el;
}

function renderBlock(block: PlacedBlock): HTMLElement {
  const { item } = block;
  // Note: block.children is empty while collapsed, so parenthood is read from
  // the model, not from the layout.
  const hasChildren = item.children.length > 0;
  const collapsed = hasChildren && state.isCollapsed(item.id);
  const isSelected = state.isItemSelected(item.id);
  let blockClass = hasChildren ? "block has-children" : "block";
  if (isSelected) blockClass += " selected";
  const el = div(blockClass);
  el.dataset.itemId = String(item.id);
  el.style.left = `${block.x}px`;
  el.style.top = `${block.y}px`;
  el.style.width = `${block.w}px`;
  el.style.height = `${block.h}px`;

  const bar = div("bar");
  if (state.isDimmed(item)) bar.classList.add("dimmed");
  bar.dataset.itemId = String(item.id);
  bar.title = item.title;
  fillBar(
    bar,
    el,
    item,
    { left: block.w, top: 0, height: PARENT_BAR_H, width: block.w },
    hasChildren ? disclosure(item, collapsed) : null,
  );
  el.append(bar);

  for (const child of block.children) {
    const c = div(state.isItemSelected(child.item.id) ? "child-bar selected" : "child-bar");
    if (state.isDimmed(child.item)) c.classList.add("dimmed");
    c.dataset.itemId = String(child.item.id);
    c.title = child.item.title;
    c.style.left = `${child.x}px`;
    c.style.top = `${child.y}px`;
    c.style.width = `${child.w}px`;
    c.style.height = `${child.h}px`;
    fillBar(c, el, child.item, {
      left: child.x + child.w,
      top: child.y,
      height: child.h,
      width: child.w,
    });
    el.append(c);
  }
  return el;
}

interface BarGeom {
  left: number; // block-relative px of the bar's right edge (label starts here)
  top: number; // block-relative px of the bar's top
  height: number; // bar height, for vertical centering of the outside label
  width: number; // bar width, to decide whether the title fits inside
}

// fillBar populates a bar. When the title fits within the bar it renders on the
// bar as before (title + link + priority pill). When it doesn't, the bar keeps
// only its resize handles and the label is placed just past the bar's right
// edge on the row background (see barOutside): each item owns its whole row, so
// that space is always free. `block` is where the outside label is appended
// (it never clips), for both the parent bar and its children. `lead` is an
// optional control placed ahead of the title — a parent's fold chevron — and so
// follows the title wherever it lands.
function fillBar(
  bar: HTMLElement,
  block: HTMLElement,
  item: Item,
  geom: BarGeom,
  lead: HTMLElement | null = null,
): void {
  const deps = depsOf(item);
  bar.append(handle("rh rh-l"));
  if (titleFits(item, geom.width, lead !== null, deps !== undefined)) {
    if (lead) bar.append(lead);
    bar.append(
      barMain(item.title, item.description),
      prioPill(item.priority),
      depMark(deps),
      flagMark(item.flagged),
    );
  } else {
    bar.append(div("bar-fill")); // flex spacer so the handles stay at the edges
    block.append(barOutside(item, geom, lead));
  }
  bar.append(handle("rh rh-r"));
}

// disclosure builds a parent's fold control. It rides with the title (inside
// the bar, or on the outside label when the title spilled), which is what makes
// it reachable on a two-pixel bar. Kept as tight as the glyph allows: it sits
// ahead of every parent title, so its width is pure indentation. Shared with
// the WBS view, as are the other exported item-furniture builders below: the
// glyphs mean the same thing in both projections, and app.ts wireChart owns
// the .disclosure click in both.
export function disclosure(item: ItemFull, collapsed: boolean): HTMLElement {
  const b = document.createElement("button");
  b.className = "disclosure";
  b.dataset.itemId = String(item.id);
  b.title = collapsed ? "Show child items" : "Hide child items";
  b.append(collapsed ? icons.chevronRight(11) : icons.chevronDown(11));
  return b;
}

// barOutside builds the label shown to the right of a too-short bar. It is
// pointer-events:none so it never interferes with drag hit-testing (only the
// link icon re-enables clicks, via CSS).
function barOutside(item: Item, geom: BarGeom, lead: HTMLElement | null = null): HTMLElement {
  const lbl = div("bar-outside");
  if (state.isDimmed(item)) lbl.classList.add("dimmed");
  lbl.style.left = `${geom.left + OUTSIDE_GAP}px`;
  lbl.style.top = `${geom.top}px`;
  lbl.style.height = `${geom.height}px`;
  if (lead) lbl.append(lead); // CSS re-enables pointer events on it
  // Mirrored order: inside a bar the title comes first and the flag sits
  // outermost on the right, so on an outside label — which runs leftwards from
  // the title — outermost means ahead of the pill.
  lbl.append(
    flagMark(item.flagged),
    depMark(depsOf(item)),
    prioPill(item.priority),
    barTitle(item.title),
    barLink(item.description),
  );
  return lbl;
}

// Non-title space reserved inside a bar when deciding whether the title fits:
// the two resize handles, the title's own padding, a little slack (so we spill
// a hair before the text would visually clip), and the pill/flag/link when
// present.
const RH_TOTAL = 16;
const TITLE_PAD = 4;
const FIT_SLACK = 4;
const PILL_RESERVE = 32;
const FLAG_RESERVE = 22;
const DEP_RESERVE = 19; // the dependency mark, when the item has edges
const LINK_RESERVE = 18;
const DISCLOSURE_RESERVE = 13; // a parent's fold chevron, when shown inside the bar
const OUTSIDE_GAP = 6; // gap between a bar and its outside label

// titleFits reports whether `item`'s title (plus its pill/flag/link/chevron
// and dependency mark, if any) fits in a bar `width` px wide. Empty titles
// never spill.
function titleFits(item: Item, width: number, hasDisclosure = false, hasDeps = false): boolean {
  if (!item.title) return true;
  let reserved = RH_TOTAL + TITLE_PAD + FIT_SLACK;
  if (hasDisclosure) reserved += DISCLOSURE_RESERVE;
  if (hasDeps) reserved += DEP_RESERVE;
  if (item.priority) reserved += PILL_RESERVE;
  if (item.flagged) reserved += FLAG_RESERVE;
  if (extractUrls(item.description)[0]) reserved += LINK_RESERVE;
  return measureTitleWidth(item.title) <= width - reserved;
}

let measureCtx: CanvasRenderingContext2D | null = null;

// measureTitleWidth returns the rendered px width of `text` in the bar-title
// font via an offscreen canvas — exact for the font and, unlike reading
// scrollWidth, without forcing a reflow. The font is read once from a probe so
// it always tracks the real .bar-title style.
function measureTitleWidth(text: string): number {
  if (!measureCtx) {
    const probe = div("bar-title");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    const cs = getComputedStyle(probe);
    const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    probe.remove();
    measureCtx = document.createElement("canvas").getContext("2d");
    if (measureCtx) measureCtx.font = font;
  }
  return measureCtx ? measureCtx.measureText(text).width : 0;
}

// A small P1..P4 badge shown at the right end of a bar. Non-interactive
// (pointer-events: none) so it never interferes with drag/drop hit-testing.
export function prioPill(priority: number | null): Node {
  if (!priority) return document.createTextNode("");
  const el = document.createElement("span");
  el.className = `prio-pill p${priority}`;
  el.textContent = `P${priority}`;
  return el;
}

// The "needs attention" flag, outermost on a bar. Like prioPill it is
// non-interactive: flagging happens in the edit panel or via the "!" shortcut,
// never by clicking the glyph, so it can't swallow a drag that starts on it.
export function flagMark(flagged: boolean): Node {
  if (!flagged) return document.createTextNode("");
  const el = document.createElement("span");
  el.className = "bar-flag";
  el.append(icons.flag(13));
  return el;
}

// The dependency mark: this item takes part in the graph. Absent when it has
// no edges — the summary map only holds entities that do, so "no entry" is
// "no mark" and the chart stays quiet for the common case.
//
// The glyph is diagramMerge, the same one the panel head's graph button wears:
// one mark means "dependencies" wherever it appears. Normally quiet — presence
// is not alarm — so it takes no fill and inherits its color, white-on-lane
// inside a bar and ink on a WBS row, which is the .bar-link precedent and
// needs no per-view rule. It turns into a filled amber chip — the flag's
// colour, for the flag's reason — when the calendar contradicts one of those
// edges, which is the one dependency state worth interrupting someone for.
//
// It carries no tooltip and no click: "d" opens the graph overlay, which
// answers what and why far better than a hover ever would, and staying inert
// keeps it out of the drag controllers' way like the rest of the furniture.
export function depMark(summary: DepSummary | undefined): Node {
  if (!summary) return document.createTextNode("");
  const el = document.createElement("span");
  el.className = summary.conflicts > 0 ? "bar-dep dep-conflict" : "bar-dep";
  el.append(icons.diagramMerge(13));
  return el;
}

// The left group of a bar: title text plus (optionally) its link icon. Kept
// in one flex:1 box so the icon hugs the end of the (possibly truncated)
// title while the priority pill stays pinned to the bar's right edge.
function barMain(title: string, description: string): HTMLElement {
  const main = div("bar-main");
  main.append(barTitle(title), barLink(description));
  return main;
}

// A small external-link icon following the bar's title, opening the first URL
// found in the item's description in a new tab. First link only — an item can
// reference many, but the card stays uncluttered and the rule is memorable.
// dnd.ts skips drag-start on `.bar-link` so the click navigates instead.
export function barLink(description: string): Node {
  const url = extractUrls(description)[0];
  if (!url) return document.createTextNode("");
  const a = document.createElement("a");
  a.className = "bar-link";
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = url;
  a.append(icons.externalLink(13));
  return a;
}

export function barTitle(text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "bar-title";
  span.textContent = text;
  return span;
}

function handle(className: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  return span;
}
