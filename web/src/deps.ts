// Dependency UI: the edit panel's "Dependencies" section. Two lists seen from
// the selected entity — "Depends on" (its prerequisites) and "Needed by" (what
// it unblocks) — so the edge's direction is chosen by *which* list you add to,
// never by a toggle. The far endpoint is picked through a dropdown that reuses
// the find machinery (search.ts): same matching, same ranking, same row
// language. Graph derivations live in deps-graph.ts (DOM-free, tested).
//
// Like labelsField, the section owns its DOM and re-renders itself after every
// local mutation: while its input has focus, the panel deliberately skips its
// own rebuild.

import { actions } from "./actions";
import { laneColorValue } from "./colors";
import { linkedRefs, refKey, splitDeps } from "./deps-graph";
import { icons } from "./icons";
import { type Match, search } from "./search";
import { state } from "./state";
import type { Dependency, DependencyRef } from "./types";

// How many dropdown rows are drawn. Tighter than the find popup's cap: this
// list lives inside a 300px-min panel, and a query that needs more rows than
// this needs more letters, not more scrolling.
const MAX_ROWS = 8;

type Direction = "dependsOn" | "neededBy";

const GROUP_TEXT: Record<Direction, { label: string; add: string; placeholder: string }> = {
  dependsOn: { label: "Depends on", add: "Add a prerequisite", placeholder: "What does this depend on?" },
  neededBy: { label: "Needed by", add: "Add a dependent", placeholder: "What needs this?" },
};

// resolveRef resolves an endpoint against live state for display. A null
// means the edge is stale (its endpoint vanished under an SSE refresh); the
// row is simply not drawn, and the next refetch drops the edge itself.
function resolveRef(ref: DependencyRef): { title: string; laneColor: string } | null {
  if (ref.kind === "item") {
    const loc = state.findItem(ref.id);
    return loc ? { title: loc.item.title, laneColor: loc.lane.color } : null;
  }
  const loc = state.findMilestone(ref.id);
  return loc ? { title: loc.milestone.title, laneColor: loc.lane.color } : null;
}

// dependenciesSection builds the panel block for one item or milestone.
export function dependenciesSection(ref: DependencyRef): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "panel-field deps-section";
  const label = document.createElement("span");
  label.textContent = "Dependencies";
  const groups = document.createElement("div");
  groups.className = "dep-groups";
  wrap.append(label, groups);

  const render = (): void => {
    groups.replaceChildren(depGroup(ref, "dependsOn", render), depGroup(ref, "neededBy", render));
  };
  render();
  return wrap;
}

function depGroup(ref: DependencyRef, dir: Direction, rerender: () => void): HTMLElement {
  const group = document.createElement("div");
  group.className = "dep-group";

  const head = document.createElement("div");
  head.className = "dep-group-head";
  const label = document.createElement("span");
  label.className = "dep-group-label";
  label.textContent = GROUP_TEXT[dir].label;
  const add = document.createElement("button");
  add.className = "icon-btn dep-add";
  add.title = GROUP_TEXT[dir].add;
  add.setAttribute("aria-label", GROUP_TEXT[dir].add);
  add.append(icons.plus(14));
  add.addEventListener("click", () => openAddDropdown(group, ref, dir, rerender));
  head.append(label, add);

  const rows = document.createElement("div");
  rows.className = "dep-rows";
  const split = splitDeps(state.current?.dependencies ?? [], ref);
  for (const dep of dir === "dependsOn" ? split.dependsOn : split.neededBy) {
    const far = dir === "dependsOn" ? dep.from : dep.to;
    const row = depRow(dep, far, rerender);
    if (row) rows.append(row);
  }

  group.append(head, rows);
  return group;
}

function depRow(dep: Dependency, far: DependencyRef, rerender: () => void): HTMLElement | null {
  const disp = resolveRef(far);
  if (disp === null) return null;

  const row = document.createElement("div");
  row.className = "dep-row";

  const go = document.createElement("button");
  go.className = "dep-go";
  go.title = `Go to ${disp.title}`;
  const dot = document.createElement("span");
  dot.className = "color-dot";
  dot.style.background = laneColorValue(disp.laneColor);
  go.append(dot);
  if (far.kind === "milestone") go.append(icons.milestone(12));
  const title = document.createElement("span");
  title.className = "dep-go-title";
  title.textContent = disp.title || "(untitled)";
  go.append(title);
  go.addEventListener("click", () => state.revealAndSelect(far.kind, far.id));

  const x = document.createElement("button");
  x.className = "icon-btn dep-x";
  x.title = "Remove dependency";
  x.append(icons.x(12));
  x.addEventListener("click", () => {
    // The optimistic apply is synchronous, so the immediate rerender already
    // sees the edge gone; a failure rolls state back and toasts.
    void actions.removeDependency(dep.id);
    rerender();
  });

  row.append(go, x);
  return row;
}

// openAddDropdown swaps a search input + result list into the group. It is the
// find popup in miniature — same search(), same row shape — but local to the
// panel and pre-filtered: the entity itself and everything already linked to
// it (either direction — re-adding or directly reversing an edge is a
// guaranteed rejection) never show up. Indirect cycles stay in the list on
// purpose: the server rejects them with the chain spelled out, and that toast
// is the explanation.
function openAddDropdown(
  group: HTMLElement,
  ref: DependencyRef,
  dir: Direction,
  rerender: () => void,
): void {
  // One dropdown at a time across the whole section.
  document.querySelector(".dep-pop")?.remove();

  const pop = document.createElement("div");
  pop.className = "menu dep-pop";
  const input = document.createElement("input");
  input.className = "find-input";
  input.type = "text";
  input.placeholder = GROUP_TEXT[dir].placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  const list = document.createElement("div");
  list.className = "find-list";
  pop.append(input, list);
  group.append(pop);

  let matches: Match[] = [];
  let cursor = 0;

  const close = (): void => pop.remove();

  const commit = (m: Match): void => {
    const far: DependencyRef = { kind: m.kind, id: m.id };
    const [from, to] = dir === "dependsOn" ? [far, ref] : [ref, far];
    close();
    void actions.addDependency(from, to).then((ok) => {
      if (ok) rerender();
    });
  };

  const runQuery = (): void => {
    const rm = state.current;
    if (!rm) {
      matches = [];
      return;
    }
    const excluded = linkedRefs(rm.dependencies, ref);
    excluded.add(refKey(ref));
    matches = search(rm, input.value)
      .filter((m) => !excluded.has(refKey({ kind: m.kind, id: m.id })))
      .slice(0, MAX_ROWS);
    cursor = 0;
  };

  const note = (text: string): HTMLElement => {
    const el = document.createElement("div");
    el.className = "menu-empty";
    el.textContent = text;
    return el;
  };

  const draw = (): void => {
    list.replaceChildren();
    if (input.value.trim() === "") {
      list.append(note("Type to search items and milestones."));
      return;
    }
    if (matches.length === 0) {
      list.append(note("No matches."));
      return;
    }
    matches.forEach((m, i) => {
      const row = document.createElement("button");
      row.className = i === cursor ? "find-row is-cursor" : "find-row";
      row.type = "button";
      const dot = document.createElement("span");
      dot.className = "color-dot";
      dot.style.background = laneColorValue(m.laneColor);
      const line = document.createElement("span");
      line.className = "find-title-line";
      if (m.kind === "milestone") line.append(icons.milestone(12));
      const title = document.createElement("span");
      title.className = "find-title";
      title.textContent = m.title || "(untitled)";
      line.append(title);
      row.append(dot, line);
      // Keep focus in the input, so the click commits before any blur-close.
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("click", () => commit(m));
      list.append(row);
    });
  };

  input.addEventListener("input", () => {
    runQuery();
    draw();
  });
  input.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "Escape":
        // This transient dropdown owns Escape, like the find popup: without
        // the stop, the global binding would also blur-and-finish the panel.
        e.stopPropagation();
        close();
        return;
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        if (matches.length > 0) {
          cursor = Math.min(matches.length - 1, Math.max(0, cursor + (e.key === "ArrowDown" ? 1 : -1)));
          draw();
        }
        return;
      case "Enter": {
        e.preventDefault();
        const m = matches[cursor];
        if (m) commit(m);
        return;
      }
      default:
    }
  });
  // Row clicks never blur (mousedown is prevented), so a blur is always a
  // genuine "clicked elsewhere" and simply dismisses the dropdown.
  input.addEventListener("blur", close);

  draw();
  input.focus();
}
