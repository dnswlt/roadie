// The type-ahead result list over the loaded roadmap: one input, a ranked
// list, one cursor. This is the single implementation behind every "type to
// find an item or milestone" surface — the find popup (find.ts) and the
// dependency picker (deps.ts) — so the keyboard contract exists exactly once:
// arrows move the cursor, Enter or a click commits, Escape dismisses.
// Matching and ranking live in search.ts (DOM-free, tested); this module is
// only the interaction seam between that and a popup.
//
// The input is created once per instance and only the result list is rebuilt
// per keystroke: re-creating the input under the user's cursor would lose
// focus and the caret on every character typed.
//
// Dismissal beyond Escape (clicking elsewhere, opening another popover) is
// the caller's job, because it is a property of the surface, not of the list:
// the find popup is a permanent topbar element toggled hidden and covered by
// the topbar's own click-away handling (app.ts), while the dependency picker
// is a transient node that manages its own.

import { laneColorValue } from "./colors";
import { icons } from "./icons";
import { type Match, search } from "./search";
import { state } from "./state";
import { dayOf, formatDay } from "./timescale";

export interface SearchListSpec {
  placeholder: string;
  // How many rows are drawn. The list is capped, the answer isn't: the count
  // head (showCount) reports the true total, and an overflow note says how
  // many rows the cap hid.
  maxRows: number;
  // Shown while the query is empty; says what is searchable here.
  emptyHint: string;
  // Show the "N matches" head line. On for the find popup, where the count is
  // part of the answer; off for the picker, whose narrow panel wants only the
  // candidates.
  showCount?: boolean;
  // Mark item rows that do not directly match the active item filter. Global
  // Find enables this because committing such a row clears that filter; the
  // dependency picker does neither.
  showFilterState?: boolean;
  // Drops candidates before counting and drawing. The picker excludes the
  // entity itself and everything already linked to it.
  filter?: (m: Match) => boolean;
  onCommit: (m: Match) => void;
  onDismiss: () => void;
}

export interface SearchList {
  // input + head + list, wrapped display:contents, so the caller's popup lays
  // the three out as its own children.
  el: HTMLElement;
  // Re-runs the query against live state and redraws. For reopening a kept
  // instance: the roadmap may have changed since the last time it was shown.
  refresh(): void;
  // Focuses the input with its text selected, so a stale query is replaced by
  // simply typing.
  focus(): void;
}

// dateText renders a match's span, collapsing a single-day item (and every
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

function renderRow(
  m: Match,
  active: boolean,
  commit: (m: Match) => void,
  showFilterState: boolean,
): HTMLElement {
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
  if (showFilterState && m.kind === "item") {
    const loc = state.findItem(m.id);
    if (loc && !state.matchesFocus(loc.item)) {
      meta.append(document.createTextNode(" · outside filter"));
      row.title = "Selecting this item clears the current filter";
    }
  }
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

export function createSearchList(spec: SearchListSpec): SearchList {
  const input = document.createElement("input");
  input.className = "find-input";
  input.type = "text";
  input.placeholder = spec.placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;

  const head = document.createElement("div");
  head.className = "find-head";
  const list = document.createElement("div");
  list.className = "find-list";

  let matches: Match[] = []; // the drawn rows (capped at maxRows)
  let total = 0; // the true total before the cap
  // Index into the drawn rows. Arrow keys move it; only Enter or a click acts
  // on it, which is what keeps a broad query from committing something nobody
  // asked for.
  let cursor = 0;

  // runQuery recomputes the match list from live state and resets the cursor.
  // Kept apart from drawing so that an arrow key only moves the highlight:
  // re-running the search per keypress is wasted work, and worse, an SSE
  // refresh landing between two arrow presses could shift the list under the
  // cursor mid-navigation.
  const runQuery = (): void => {
    const rm = state.current;
    let all = rm ? search(rm, input.value) : [];
    if (spec.filter) all = all.filter(spec.filter);
    total = all.length;
    matches = all.slice(0, spec.maxRows);
    cursor = 0;
  };

  const draw = (): void => {
    head.replaceChildren();
    list.replaceChildren();

    if (input.value.trim() === "") {
      list.append(note(spec.emptyHint));
      return;
    }
    if (total === 0) {
      list.append(note("No matches."));
      return;
    }
    if (spec.showCount) {
      head.textContent = total === 1 ? "1 match" : `${total} matches`;
    }
    // Resolving a row against the filter costs a findItem scan each, so the
    // rows only ask when there is a filter to be outside of.
    const markOutside = spec.showFilterState === true && state.focus !== null;
    matches.forEach((m, i) => list.append(renderRow(m, i === cursor, spec.onCommit, markOutside)));
    if (total > matches.length) {
      list.append(note(`+${total - matches.length} more — narrow the query.`));
    }
  };

  const moveCursor = (delta: number): void => {
    if (matches.length === 0) return;
    cursor = Math.min(matches.length - 1, Math.max(0, cursor + delta));
    draw();
    list.querySelector<HTMLElement>(".find-row.is-cursor")?.scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("input", () => {
    runQuery();
    draw();
  });
  input.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "Escape":
        // Swallowed here on purpose: a transient popup owns Escape. The
        // global binding is reserved for finishing edits in panel fields.
        e.stopPropagation();
        spec.onDismiss();
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
        const m = matches[cursor];
        if (m) spec.onCommit(m);
        return;
      }
      default:
    }
  });

  const el = document.createElement("div");
  el.className = "search-list";
  el.append(input, head, list);

  return {
    el,
    refresh(): void {
      runQuery();
      draw();
    },
    focus(): void {
      input.focus();
      input.select();
    },
  };
}
