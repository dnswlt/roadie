// Renders the WBS outline from the current state: the same model as the
// timeline chart with the time axis projected away. Lanes stay lanes (same
// .lane/.lane-label rail, so every label gesture and the grip reorder drag
// work unchanged); items become uniform full-width rows, children indented
// inside their parent's block; milestones a small foldable group at the top
// of each lane. Rebuilt on every state change, like render.ts.
//
// The item rows deliberately share NO classes with the timeline's bars: each
// pointer controller must only ever see its own view's elements, so dnd.ts
// (which matches .bar/.child-bar) is structurally inert here rather than
// gated by a mode check. Row clicks are handled in app.ts wireChart. The
// shared appearance lives in styles.css; the shared furniture builders
// (title, pill, flag, link, chevron) come from render.ts.

import { laneColorValue } from "./colors";
import { icons } from "./icons";
import { barLink, barTitle, disclosure, emptyState, flagMark, laneLabel, prioPill } from "./render";
import { state } from "./state";
import { dayOf, formatDay } from "./timescale";
import type { Item, ItemFull, LaneFull, Milestone } from "./types";

function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

export function renderWbs(container: HTMLElement): void {
  const rm = state.current;
  const scrollTop = container.scrollTop;
  container.replaceChildren();

  if (!rm) {
    container.append(emptyState());
    return;
  }

  const lanesEl = div("lanes");
  const visibleLanes = rm.lanes.filter((l) => !state.isLaneHidden(l.id));
  for (const lane of visibleLanes) {
    lanesEl.append(renderLaneSection(lane));
  }
  // Same hints as the timeline (render.ts) — the situations are identical.
  if (rm.lanes.length === 0) {
    const hint = div("lanes-hint");
    hint.textContent = "This roadmap has no contexts yet — add one below.";
    lanesEl.append(hint);
  } else if (visibleLanes.length === 0) {
    const hint = div("lanes-hint");
    hint.textContent = "All contexts are hidden — use the eye menu to show them.";
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
  for (const item of lane.items) rows.append(renderItemBlock(item));

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

function renderMilestoneRow(m: Milestone): HTMLElement {
  const el = div(state.selectedMilestoneId === m.id ? "wbs-milestone selected" : "wbs-milestone");
  // Milestones carry neither labels nor a flag, so any active focus dims them
  // (as in the timeline).
  if (state.focus !== null) el.classList.add("dimmed");
  el.dataset.milestoneId = String(m.id);
  const title = div("wbs-ms-title");
  title.textContent = m.title;
  const date = div("wbs-dates");
  date.textContent = formatDay(dayOf(m.date));
  el.append(div("wbs-ms-diamond"), title, date);
  return el;
}

// renderItemBlock builds a top-level item's rows: the parent row plus, unless
// folded, one indented row per child — the same containment the timeline
// draws, with the tinted block backdrop marking the family.
function renderItemBlock(item: ItemFull): HTMLElement {
  const hasChildren = item.children.length > 0;
  const collapsed = hasChildren && state.isCollapsed(item.id);
  const block = div(hasChildren ? "wbs-block has-children" : "wbs-block");
  block.append(renderRow(item, hasChildren ? disclosure(item, collapsed) : null, false));
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
  if (state.isDimmed(item)) row.classList.add("dimmed");
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
  const dates = div("wbs-dates");
  dates.textContent = `${formatDay(dayOf(item.startDate))} – ${formatDay(dayOf(item.endDate))}`;
  row.append(dates, prioPill(item.priority), flagMark(item.flagged));
  return row;
}
