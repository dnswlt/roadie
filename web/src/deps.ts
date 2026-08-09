// Dependency UI, in two parts.
//
// The edit panel's "Dependencies" section: two lists seen from the selected
// entity — "Depends on" (its prerequisites) and "Needed by" (what it unblocks)
// — so the edge's direction is chosen by *which* list you add to, never by a
// toggle. The far endpoint is picked through a dropdown that reuses the find
// machinery (search.ts): same matching, same ranking, same row language. Like
// labelsField, the section owns its DOM and re-renders itself after every
// local mutation: while its input has focus, the panel deliberately skips its
// own rebuild.
//
// The local graph overlay: one entity with its one-hop neighborhood, drawn
// topologically (prerequisites → node → dependents), deliberately *not* on the
// timeline — the chart projects time, and dependency arrows across it are the
// spaghetti this feature exists to avoid. One hop plus click-to-recenter gives
// full graph traversal without ever laying out a global graph.
//
// Graph derivations live in deps-graph.ts (DOM-free, tested).

import { actions } from "./actions";
import { laneColorValue } from "./colors";
import { dateConflict, linkedRefs, refKey, splitDeps } from "./deps-graph";
import { icons } from "./icons";
import { type Match, search } from "./search";
import { state } from "./state";
import { dayOf, formatDay } from "./timescale";
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
  const head = document.createElement("div");
  head.className = "deps-head";
  const label = document.createElement("span");
  label.className = "panel-field-label";
  label.textContent = "Dependencies";
  const graph = document.createElement("button");
  graph.className = "icon-btn";
  graph.title = "Dependency graph (d)";
  graph.setAttribute("aria-label", "Dependency graph");
  graph.append(icons.waypoints(14));
  graph.addEventListener("click", () => openDepsOverlay(ref));
  head.append(label, graph);
  const groups = document.createElement("div");
  groups.className = "dep-groups";
  wrap.append(head, groups);

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

  // Idempotent, and it has to be: removing the pop while its input holds
  // focus makes Chrome fire blur *during* the removal, and the blur handler
  // below is this very function. Without the guard the re-entrant call
  // detaches the pop under the outer remove(), which then throws — killing
  // the commit before the API call ever runs.
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    pop.remove();
  };

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

// ---- The local graph overlay -------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

// refDates resolves an endpoint's span for the date-conflict check: an item's
// start/end, a milestone's date standing in for both.
function refDates(ref: DependencyRef): { start: string; end: string } | null {
  if (ref.kind === "item") {
    const loc = state.findItem(ref.id);
    return loc ? { start: loc.item.startDate, end: loc.item.endDate } : null;
  }
  const loc = state.findMilestone(ref.id);
  return loc ? { start: loc.milestone.date, end: loc.milestone.date } : null;
}

// edgeConflict resolves one edge's endpoints against live state and asks
// deps-graph.ts whether their dates contradict the dependency.
function edgeConflict(dep: Dependency): boolean {
  const from = refDates(dep.from);
  const to = refDates(dep.to);
  return from !== null && to !== null && dateConflict(from.end, to.start);
}

function spanText(ref: DependencyRef): string {
  const dates = refDates(ref);
  if (!dates) return "";
  const from = formatDay(dayOf(dates.start));
  if (dates.start === dates.end) return from;
  return `${from} – ${formatDay(dayOf(dates.end))}`;
}

// openDepsForSelection is the "d" shortcut: the graph of the selected item or
// milestone. Needs exactly one target, like "e" — selectedItemId is null for a
// multi-selection, so it no-ops there.
export function openDepsForSelection(): void {
  const msId = state.selectedMilestoneId;
  if (msId !== null) {
    openDepsOverlay({ kind: "milestone", id: msId });
    return;
  }
  const id = state.selectedItemId;
  if (id !== null) openDepsOverlay({ kind: "item", id });
}

// openDepsOverlay shows one entity with its one-hop neighborhood in the shared
// modal. Read-only by construction — it only reads state and navigates — so it
// is equally safe over a snapshot preview.
export function openDepsOverlay(ref: DependencyRef): void {
  const dlg = document.getElementById("dialog") as HTMLDialogElement;
  dlg.classList.add("deps-dialog");
  // The wires are drawn from measured card positions, so a window resize
  // (which reflows the cards) invalidates them.
  const onResize = (): void => drawWires(dlg);
  window.addEventListener("resize", onResize);
  dlg.addEventListener(
    "close",
    () => {
      dlg.classList.remove("deps-dialog");
      window.removeEventListener("resize", onResize);
    },
    { once: true },
  );
  renderGraph(dlg, ref);
  dlg.showModal();
  // Measuring needs layout, which exists only once the dialog is open.
  drawWires(dlg);
}

// nodeCard builds one card. Side cards are buttons that re-center the graph —
// which is the whole traversal model: one hop drawn, any hop reachable.
function nodeCard(
  dlg: HTMLDialogElement,
  ref: DependencyRef,
  opts: { center?: boolean; side?: "left" | "right"; conflict?: boolean },
): HTMLElement | null {
  const disp = resolveRef(ref);
  if (!disp) return null;
  const card = document.createElement(opts.center ? "div" : "button");
  card.className = opts.center ? "deps-node deps-node-center" : "deps-node";
  if (opts.side) (card as HTMLElement).dataset.side = opts.side;
  if (opts.conflict) {
    card.classList.add("is-conflict");
    card.title = "Dates conflict: the prerequisite is scheduled to end after this dependency needs it.";
  }
  card.style.setProperty("--c", laneColorValue(disp.laneColor));

  const title = document.createElement("span");
  title.className = "deps-node-title";
  if (ref.kind === "milestone") title.append(icons.milestone(12));
  const text = document.createElement("span");
  text.className = "deps-node-title-text";
  text.textContent = disp.title || "(untitled)";
  title.append(text);

  const meta = document.createElement("span");
  meta.className = "deps-node-meta";
  meta.textContent = spanText(ref);

  card.append(title, meta);
  if (!opts.center) {
    card.addEventListener("click", () => {
      renderGraph(dlg, ref);
      drawWires(dlg);
    });
  }
  return card;
}

function renderGraph(dlg: HTMLDialogElement, ref: DependencyRef): void {
  const center = nodeCard(dlg, ref, { center: true });
  if (!center) {
    // The entity vanished (stale ref under an SSE refresh): nothing to show.
    dlg.close();
    return;
  }
  dlg.replaceChildren();

  const h = document.createElement("h3");
  h.textContent = "Dependencies";

  const canvas = document.createElement("div");
  canvas.className = "deps-canvas";
  const wires = document.createElementNS(SVG_NS, "svg");
  wires.setAttribute("class", "deps-wires");
  const cols = document.createElement("div");
  cols.className = "deps-cols";

  const column = (label: string, empty: string): { el: HTMLElement; list: HTMLElement } => {
    const el = document.createElement("div");
    el.className = "deps-col";
    const lab = document.createElement("span");
    lab.className = "deps-col-label";
    lab.textContent = label;
    const list = document.createElement("div");
    list.className = "deps-col-list";
    el.append(lab, list);
    const note = document.createElement("span");
    note.className = "deps-empty";
    note.textContent = empty;
    list.append(note); // replaced by the first card
    return { el, list };
  };

  const split = splitDeps(state.current?.dependencies ?? [], ref);
  const left = column("Depends on", "No prerequisites.");
  const right = column("Needed by", "Nothing depends on this.");
  const fill = (list: HTMLElement, cards: (HTMLElement | null)[]): void => {
    const real = cards.filter((c) => c !== null);
    if (real.length > 0) list.replaceChildren(...real);
  };
  fill(
    left.list,
    split.dependsOn.map((d) => nodeCard(dlg, d.from, { side: "left", conflict: edgeConflict(d) })),
  );
  fill(
    right.list,
    split.neededBy.map((d) => nodeCard(dlg, d.to, { side: "right", conflict: edgeConflict(d) })),
  );

  const centerCol = document.createElement("div");
  centerCol.className = "deps-col deps-col-center";
  centerCol.append(center);

  cols.append(left.el, centerCol, right.el);
  canvas.append(wires, cols);

  const hint = document.createElement("p");
  hint.className = "deps-hint";
  hint.textContent = "Click a connected node to move through the graph.";

  const row = document.createElement("div");
  row.className = "dialog-actions";
  const show = document.createElement("button");
  show.type = "button";
  show.className = "btn";
  show.textContent = "Show on chart";
  show.addEventListener("click", () => {
    dlg.close();
    state.revealAndSelect(ref.kind, ref.id);
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-primary";
  close.textContent = "Close";
  close.addEventListener("click", () => dlg.close());
  row.append(show, close);

  dlg.append(h, canvas, hint, row);
}

// drawWires connects each side card to the center card with a bezier, drawn in
// an absolutely positioned SVG under the cards. Positions are measured from
// the live layout, so this runs after every render and on window resize.
function drawWires(dlg: HTMLElement): void {
  const canvas = dlg.querySelector<HTMLElement>(".deps-canvas");
  const svg = canvas?.querySelector<SVGSVGElement>("svg.deps-wires");
  const center = canvas?.querySelector<HTMLElement>(".deps-node-center");
  if (!canvas || !svg || !center) return;

  svg.replaceChildren();
  const box = canvas.getBoundingClientRect();
  svg.setAttribute("width", String(box.width));
  svg.setAttribute("height", String(box.height));

  const cRect = center.getBoundingClientRect();
  const edgeMid = (r: DOMRect, side: "left" | "right"): { x: number; y: number } => ({
    x: (side === "left" ? r.left : r.right) - box.left,
    y: r.top + r.height / 2 - box.top,
  });

  for (const card of canvas.querySelectorAll<HTMLElement>(".deps-node[data-side]")) {
    const r = card.getBoundingClientRect();
    // Wires always run left→right, the topological direction of the layout:
    // prerequisite → center, or center → dependent.
    const a = card.dataset.side === "left" ? edgeMid(r, "right") : edgeMid(cRect, "right");
    const b = card.dataset.side === "left" ? edgeMid(cRect, "left") : edgeMid(r, "left");
    const dx = Math.max(24, (b.x - a.x) / 2);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`);
    path.setAttribute(
      "class",
      card.classList.contains("is-conflict") ? "deps-wire is-conflict" : "deps-wire",
    );
    svg.append(path);
  }
}
