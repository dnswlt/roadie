// Renders the swimlane chart from the current state. The chart is rebuilt
// on every state change; scroll position is preserved across rebuilds.

import { laneColorValue } from "./colors";
import { icons } from "./icons";
import { LABEL_W, layoutLane, type PlacedBlock } from "./layout";
import { state } from "./state";
import {
  chartWidth,
  computeRange,
  monthTicks,
  quarterTicks,
  todayDay,
  xOf,
  type Scale,
} from "./timescale";
import type { LaneFull } from "./types";

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

  // Lanes.
  const lanesEl = div("lanes");
  for (const lane of rm.lanes) {
    lanesEl.append(renderLane(lane, w));
  }
  if (rm.lanes.length === 0) {
    const hint = div("lanes-hint");
    hint.textContent = "This roadmap has no contexts yet — add one below.";
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

  if (state.scrollToToday) {
    state.scrollToToday = false;
    container.scrollLeft = Math.max(0, LABEL_W + tx - container.clientWidth / 2);
    container.scrollTop = 0;
  } else {
    container.scrollLeft = scrollLeft;
    container.scrollTop = scrollTop;
  }
}

function renderLane(lane: LaneFull, chartW: number): HTMLElement {
  const layout = layoutLane(lane, scale);
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
  const color = document.createElement("button");
  color.className = "icon-btn lane-color";
  color.title = "Lane color";
  const dot = document.createElement("span");
  dot.className = "color-dot";
  color.append(dot);
  const del = document.createElement("button");
  del.className = "icon-btn lane-del";
  del.title = "Delete context";
  del.append(icons.trash(14));
  laneActions.append(add, color, del);
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

  for (const block of layout.blocks) {
    canvas.append(renderBlock(block));
  }

  laneEl.append(label, canvas);
  return laneEl;
}

function renderBlock(block: PlacedBlock): HTMLElement {
  const { item } = block;
  const hasChildren = block.children.length > 0;
  const isSelected = state.selectedItemId === item.id;
  let blockClass = hasChildren ? "block has-children" : "block";
  if (isSelected) blockClass += " selected";
  const el = div(blockClass);
  el.dataset.itemId = String(item.id);
  el.style.left = `${block.x}px`;
  el.style.top = `${block.y}px`;
  el.style.width = `${block.w}px`;
  el.style.height = `${block.h}px`;

  const bar = div("bar");
  bar.dataset.itemId = String(item.id);
  bar.title = item.title;
  bar.append(handle("rh rh-l"), barTitle(item.title), handle("rh rh-r"));
  el.append(bar);

  for (const child of block.children) {
    const c = div(state.selectedItemId === child.item.id ? "child-bar selected" : "child-bar");
    c.dataset.itemId = String(child.item.id);
    c.title = child.item.title;
    c.style.left = `${child.x}px`;
    c.style.top = `${child.y}px`;
    c.style.width = `${child.w}px`;
    c.style.height = `${child.h}px`;
    c.append(handle("rh rh-l"), barTitle(child.item.title), handle("rh rh-r"));
    el.append(c);
  }
  return el;
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
