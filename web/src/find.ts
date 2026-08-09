// The find popup: a dropdown over the loaded roadmap, opened with "/" or the
// magnifier in the topbar. Matching and ranking live in search.ts (DOM-free and
// unit-tested); this module is only the popup and its keyboard.
//
// It deliberately does *not* filter or dim the chart. Picking a row is the only
// thing that changes what you're looking at, and until then nothing is selected
// — a broad query like "whe" is allowed to return hundreds of rows without
// yanking the edit panel onto whichever one happened to sort first.
//
// The shell (input + result list) is built once and only the result list is
// rebuilt per keystroke: re-creating the input under the user's cursor would
// lose focus and the caret on every character typed.

import { laneColorValue } from "./colors";
import { icons } from "./icons";
import { type Match, search } from "./search";
import { state } from "./state";
import { dayOf, formatDay } from "./timescale";

// How many rows are drawn. The header count is always the true total — the
// list is capped, the answer isn't.
const MAX_ROWS = 50;

let popEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let headEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;

let matches: Match[] = [];
// Index into the drawn rows. Arrow keys move it; only Enter or a click acts on
// it, which is what keeps a broad query from opening a panel nobody asked for.
let cursor = 0;

function $pop(): HTMLElement {
  popEl ??= document.getElementById("find-pop")!;
  return popEl;
}

function isOpen(): boolean {
  return !$pop().classList.contains("hidden");
}

function buildShell(): void {
  const pop = $pop();
  if (inputEl) return;

  const input = document.createElement("input");
  input.id = "find-input";
  input.className = "find-input";
  input.type = "text";
  input.placeholder = "Find items, milestones, contexts…";
  input.autocomplete = "off";
  input.spellcheck = false;

  const head = document.createElement("div");
  head.className = "find-head";
  const list = document.createElement("div");
  list.className = "find-list";

  input.addEventListener("input", () => {
    runQuery();
    drawResults();
  });
  input.addEventListener("keydown", onInputKey);

  pop.replaceChildren(input, head, list);
  inputEl = input;
  headEl = head;
  listEl = list;
}

function onInputKey(e: KeyboardEvent): void {
  switch (e.key) {
    case "Escape":
      // Swallowed here on purpose: this transient popup owns Escape. The
      // global binding is reserved for finishing edits in panel fields.
      e.stopPropagation();
      closeFind();
      return;
    case "ArrowDown":
      e.preventDefault();
      moveCursor(1);
      return;
    case "ArrowUp":
      e.preventDefault();
      moveCursor(-1);
      return;
    case "Enter": {
      e.preventDefault();
      const m = drawn()[cursor];
      if (m) commit(m);
      return;
    }
    default:
  }
}

function drawn(): Match[] {
  return matches.slice(0, MAX_ROWS);
}

function moveCursor(delta: number): void {
  const n = drawn().length;
  if (n === 0) return;
  cursor = Math.min(n - 1, Math.max(0, cursor + delta));
  drawResults();
  listEl?.querySelector<HTMLElement>(".find-row.is-cursor")?.scrollIntoView({ block: "nearest" });
}

// dateText renders an item's span, collapsing a single-day item (and every
// milestone, which has no duration) to one date.
function dateText(m: Match): string {
  const from = formatDay(dayOf(m.startDate));
  if (m.startDate === m.endDate) return from;
  return `${from} – ${formatDay(dayOf(m.endDate))}`;
}

// Tags name the field a row matched on when it wasn't the title, because that
// hit is invisible on the chart — without this, a row looks like a bug.
const TAG_TEXT: Record<Match["field"], string> = {
  title: "",
  label: "label",
  description: "notes",
  context: "context",
};

function renderRow(m: Match, active: boolean): HTMLElement {
  const row = document.createElement("button");
  row.className = active ? "find-row is-cursor" : "find-row";
  row.type = "button";

  const dot = document.createElement("span");
  dot.className = "color-dot";
  dot.style.background = laneColorValue(m.laneColor);

  const text = document.createElement("span");
  text.className = "find-text";

  const titleLine = document.createElement("span");
  titleLine.className = "find-title-line";
  if (m.kind === "milestone") titleLine.append(icons.milestone(12));
  const title = document.createElement("span");
  title.className = "find-title";
  title.textContent = m.title || "(untitled)";
  titleLine.append(title);
  if (m.field !== "title") {
    const tag = document.createElement("span");
    tag.className = "find-tag";
    tag.textContent = TAG_TEXT[m.field];
    titleLine.append(tag);
  }

  const meta = document.createElement("span");
  meta.className = "find-meta";
  meta.textContent = `${m.laneName} · ${dateText(m)}`;
  // A match in a hidden context is the case the browser's own find cannot
  // reach at all, so say so rather than letting the row look like any other.
  if (state.isLaneHidden(m.laneId)) meta.append(icons.eyeOff(12));

  text.append(titleLine, meta);
  row.append(dot, text);
  row.addEventListener("click", () => commit(m));
  return row;
}

function note(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "menu-empty";
  el.textContent = text;
  return el;
}

// runQuery recomputes the match list from live state and resets the cursor.
// Kept apart from drawing so that an arrow key only moves the highlight:
// re-running the search per keypress is wasted work, and worse, an SSE refresh
// landing between two arrow presses could shift the list under the cursor
// mid-navigation.
function runQuery(): void {
  const rm = state.current;
  matches = rm && inputEl ? search(rm, inputEl.value) : [];
  cursor = 0;
}

function drawResults(): void {
  if (!inputEl || !headEl || !listEl) return;
  const query = inputEl.value;

  headEl.replaceChildren();
  listEl.replaceChildren();

  if (query.trim() === "") {
    listEl.append(note("Type to search titles, labels, notes and context names."));
    return;
  }
  if (matches.length === 0) {
    listEl.append(note("No matches."));
    return;
  }

  headEl.textContent = matches.length === 1 ? "1 match" : `${matches.length} matches`;
  const rows = drawn();
  if (cursor >= rows.length) cursor = rows.length - 1;
  rows.forEach((m, i) => listEl!.append(renderRow(m, i === cursor)));
  if (matches.length > rows.length) {
    listEl.append(note(`+${matches.length - rows.length} more — narrow the query.`));
  }
}

// commit is the only thing here that changes the chart. A match may sit in a
// hidden context or under a folded parent, and may have moved or vanished
// since the list was drawn (an SSE refresh mid-search is not deferred for this
// popup — events.ts defers only for the edit panel); revealAndSelect resolves
// against live state and handles both.
function commit(m: Match): void {
  closeFind();
  state.revealAndSelect(m.kind, m.id);
}

export function closeFind(): void {
  $pop().classList.add("hidden");
}

export function openFind(): void {
  if (!state.current) return;
  // Owning the topbar: every other popover closes, the same way opening any
  // of them closes this one (see wireTopbar).
  for (const p of document.querySelectorAll<HTMLElement>(".topbar .menu")) {
    p.classList.add("hidden");
  }
  buildShell();
  $pop().classList.remove("hidden");
  // Results are recomputed rather than reused: the roadmap may have changed
  // (an edit, an SSE refresh) since this popup was last open.
  runQuery();
  drawResults();
  inputEl?.focus();
  inputEl?.select();
}

function toggleFind(): void {
  if (isOpen()) closeFind();
  else openFind();
}

export function initFind(): void {
  document.getElementById("find-menu")!.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFind();
  });
}
