// Renders the swimlane chart from the current state. The chart is rebuilt
// on every state change; scroll position is preserved across rebuilds.

import { laneColorValue } from "./colors";
import { icons } from "./icons";
import { LABEL_W, PARENT_BAR_H, layoutLane, type PlacedBlock } from "./layout";
import { extractUrls } from "./links";
import { state } from "./state";
import {
  chartWidth,
  computeRange,
  dayOf,
  monthTicks,
  quarterTicks,
  todayDay,
  xOf,
  type Scale,
} from "./timescale";
import type { Item, ItemFull, LaneFull, Milestone } from "./types";

let scale: Scale = { startDay: 0, endDay: 0, pxPerDay: 3 };

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

  const scrollLeft = container.scrollLeft;
  const scrollTop = container.scrollTop;
  container.replaceChildren();

  if (!rm) {
    const empty = div("empty-state");
    const msg = div("empty-msg");
    msg.textContent = "No roadmap yet.";
    const btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.id = "empty-create";
    btn.textContent = "Create your first roadmap";
    empty.append(msg, btn);
    container.append(empty);
    return;
  }

  const w = chartWidth(scale);
  const grid = div("grid");
  grid.style.width = `${LABEL_W + w}px`;

  // Time axis header: quarters row + months row.
  const thead = div("thead");
  const corner = div("corner");
  corner.textContent = "Contexts";
  const thRows = div("th-rows");
  thRows.style.width = `${w}px`;
  const qRow = div("th-row th-quarters");
  for (const t of quarterTicks(scale)) {
    const cell = div("th-cell");
    cell.style.width = `${t.days * scale.pxPerDay}px`;
    cell.textContent = t.days * scale.pxPerDay >= 44 ? t.label : "";
    qRow.append(cell);
  }
  const mRow = div("th-row th-months");
  for (const t of monthTicks(scale)) {
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
  thRows.append(qRow, mRow);
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

function renderLane(lane: LaneFull, chartW: number): HTMLElement {
  const layout = layoutLane(lane, scale, (id) => state.isCollapsed(id));
  const laneEl = div("lane");
  laneEl.dataset.laneId = String(lane.id);
  laneEl.style.setProperty("--c", laneColorValue(lane.color));

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

  const canvas = div("lane-canvas");
  canvas.style.width = `${chartW}px`;
  canvas.style.height = `${layout.height}px`;

  // Month gridlines; quarter starts slightly stronger.
  for (const t of monthTicks(scale)) {
    const d = new Date(t.day * 86_400_000);
    const gl = div(d.getUTCDate() === 1 && d.getUTCMonth() % 3 === 0 ? "gl gl-q" : "gl");
    gl.style.left = `${xOf(scale, t.day)}px`;
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

  // Milestone diamonds live in a reserved band at the lane top.
  for (const m of lane.milestones) {
    canvas.append(renderMilestone(m));
  }

  laneEl.append(label, canvas);
  return laneEl;
}

function renderMilestoneLine(m: Milestone): HTMLElement {
  const line = div("milestone-line");
  if (state.isDimmed([])) line.classList.add("dimmed");
  line.style.left = `${xOf(scale, dayOf(m.date))}px`;
  return line;
}

function renderMilestone(m: Milestone): HTMLElement {
  const el = div(state.selectedMilestoneId === m.id ? "milestone selected" : "milestone");
  // Milestones carry no labels, so any active focus dims them all.
  if (state.isDimmed([])) el.classList.add("dimmed");
  el.dataset.milestoneId = String(m.id);
  el.title = m.title;
  el.style.left = `${xOf(scale, dayOf(m.date))}px`;
  const diamond = div("milestone-diamond");
  el.append(diamond);
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
  if (state.isDimmed(item.labels)) bar.classList.add("dimmed");
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
    if (state.isDimmed(child.item.labels)) c.classList.add("dimmed");
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
  bar.append(handle("rh rh-l"));
  if (titleFits(item, geom.width, lead !== null)) {
    if (lead) bar.append(lead);
    bar.append(barMain(item.title, item.description), prioPill(item.priority));
  } else {
    bar.append(div("bar-fill")); // flex spacer so the handles stay at the edges
    block.append(barOutside(item, geom, lead));
  }
  bar.append(handle("rh rh-r"));
}

// disclosure builds a parent's fold control. It rides with the title (inside
// the bar, or on the outside label when the title spilled), which is what makes
// it reachable on a two-pixel bar. Kept as tight as the glyph allows: it sits
// ahead of every parent title, so its width is pure indentation.
function disclosure(item: ItemFull, collapsed: boolean): HTMLElement {
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
  if (state.isDimmed(item.labels)) lbl.classList.add("dimmed");
  lbl.style.left = `${geom.left + OUTSIDE_GAP}px`;
  lbl.style.top = `${geom.top}px`;
  lbl.style.height = `${geom.height}px`;
  if (lead) lbl.append(lead); // CSS re-enables pointer events on it
  lbl.append(prioPill(item.priority), barTitle(item.title), barLink(item.description));
  return lbl;
}

// Non-title space reserved inside a bar when deciding whether the title fits:
// the two resize handles, the title's own padding, a little slack (so we spill
// a hair before the text would visually clip), and the pill/link when present.
const RH_TOTAL = 16;
const TITLE_PAD = 4;
const FIT_SLACK = 4;
const PILL_RESERVE = 32;
const LINK_RESERVE = 18;
const DISCLOSURE_RESERVE = 13; // a parent's fold chevron, when shown inside the bar
const OUTSIDE_GAP = 6; // gap between a bar and its outside label

// titleFits reports whether `item`'s title (plus its pill/link/chevron, if any)
// fits in a bar `width` px wide. Empty titles never spill.
function titleFits(item: Item, width: number, hasDisclosure = false): boolean {
  if (!item.title) return true;
  let reserved = RH_TOTAL + TITLE_PAD + FIT_SLACK;
  if (hasDisclosure) reserved += DISCLOSURE_RESERVE;
  if (item.priority) reserved += PILL_RESERVE;
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
function prioPill(priority: number | null): Node {
  if (!priority) return document.createTextNode("");
  const el = document.createElement("span");
  el.className = `prio-pill p${priority}`;
  el.textContent = `P${priority}`;
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
function barLink(description: string): Node {
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

function barTitle(text: string): HTMLElement {
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
