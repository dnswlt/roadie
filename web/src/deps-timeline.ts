// Selection-scoped dependency focus for the timeline. Unlike the graph dialog,
// this projection keeps entities at their real dates and rows. It draws only
// the selected entity's incident edges: enough to read local schedule context
// without turning the whole roadmap into a global edge diagram.

import { refKey, splitDeps } from "./deps-graph";
import {
  dependencyPaths,
  type DependencyPoint,
  timelineEdgeRefs,
} from "./deps-timeline-path";
import { state } from "./state";
import type { Dependency } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
let active = false;

interface Endpoint {
  measure: HTMLElement;
  point: "right" | "center";
}

interface VisibleEdge {
  dependency: Dependency;
  start: DependencyPoint;
  target: DependencyPoint;
}

// The topbar owns the mode's visible pressed state. Keeping the flag here lets
// selection projection redraw connections without putting view-only state in
// the roadmap model.
export function timelineDependenciesActive(): boolean {
  return active;
}

export function toggleTimelineDependencies(): void {
  if (state.navigation.view !== "timeline") return;
  active = !active;
  state.notifySelection();
}

function endpointsIn(lanes: HTMLElement): Map<string, Endpoint> {
  const endpoints = new Map<string, Endpoint>();
  for (const el of lanes.querySelectorAll<HTMLElement>(".bar[data-item-id], .child-bar[data-item-id]")) {
    const id = Number(el.dataset.itemId);
    endpoints.set(refKey({ kind: "item", id }), { measure: el, point: "right" });
  }
  for (const el of lanes.querySelectorAll<HTMLElement>(".milestone[data-milestone-id]")) {
    const id = Number(el.dataset.milestoneId);
    const diamond = el.querySelector<HTMLElement>(".milestone-diamond");
    if (diamond) {
      endpoints.set(refKey({ kind: "milestone", id }), {
        measure: diamond,
        point: "center",
      });
    }
  }
  return endpoints;
}

function pointOf(endpoint: Endpoint, origin: DOMRect): DependencyPoint {
  const rect = endpoint.measure.getBoundingClientRect();
  // Dependencies have finish-to-finish calendar semantics. Items therefore
  // anchor at their right edge; a milestone's diamond is its one date.
  return {
    x: (endpoint.point === "right" ? rect.right : rect.left + rect.width / 2) - origin.left,
    y: rect.top + rect.height / 2 - origin.top,
  };
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

function marker(id: string, className: string): SVGMarkerElement {
  const el = svgEl("marker");
  el.id = id;
  el.setAttribute("viewBox", "0 0 8 8");
  // The triangle's tip, rather than its center, lands on the bar edge.
  el.setAttribute("refX", "8");
  el.setAttribute("refY", "4");
  el.setAttribute("markerWidth", "10");
  el.setAttribute("markerHeight", "10");
  el.setAttribute("markerUnits", "userSpaceOnUse");
  el.setAttribute("orient", "auto");
  const tip = svgEl("path");
  tip.setAttribute("d", "M 0 0 L 8 4 L 0 8 z");
  tip.setAttribute("class", className);
  el.append(tip);
  return el;
}

function addPath(
  edges: SVGGElement,
  arrows: SVGGElement,
  edge: VisibleEdge,
  conflict: boolean,
): void {
  const paths = dependencyPaths(edge.start, edge.target);
  const path = svgEl("path");
  path.setAttribute("d", paths.body);
  path.setAttribute("class", conflict ? "timeline-dep-edge dep-conflict" : "timeline-dep-edge");
  path.dataset.dependencyId = String(edge.dependency.id);
  const arrow = svgEl("path");
  arrow.setAttribute("d", paths.arrow);
  arrow.setAttribute("class", "timeline-dep-arrow-guide");
  arrow.setAttribute("marker-end", conflict ? "url(#timeline-dep-arrow-conflict)" : "url(#timeline-dep-arrow)");
  edges.append(path);
  arrows.append(arrow);
}

function noteAt(overlay: HTMLElement, point: DependencyPoint, text: string): void {
  const note = document.createElement("div");
  note.className = "timeline-deps-note";
  note.style.top = `${Math.max(2, point.y - 30)}px`;
  note.textContent = text;
  overlay.append(note);
  // Open leftward from the finish point. Unlike viewport clamping, this stays
  // correct when a full render restores or a zoom adjusts horizontal scroll.
  note.style.left = `${Math.max(2, point.x - note.offsetWidth - 10)}px`;
}

// renderTimelineDependencies rebuilds only the inert overlay. It is called by
// both existing invalidation scopes: after a full timeline render, and from
// projectSelection without replacing any chart node.
export function renderTimelineDependencies(container: HTMLElement): void {
  container.querySelector(".timeline-deps-overlay")?.remove();
  if (!active) return;

  const selected = state.singleSelection();
  const lanes = container.querySelector<HTMLElement>(".lanes");
  if (!selected || !lanes) return;

  const endpoints = endpointsIn(lanes);
  const center = endpoints.get(refKey(selected));
  if (!center) return;
  const origin = lanes.getBoundingClientRect();
  const points = new Map<Endpoint, DependencyPoint>();
  const pointFor = (endpoint: Endpoint): DependencyPoint => {
    let point = points.get(endpoint);
    if (!point) {
      point = pointOf(endpoint, origin);
      points.set(endpoint, point);
    }
    return point;
  };

  const split = splitDeps(state.current?.dependencies ?? [], selected);
  const incident = [...split.dependsOn, ...split.neededBy];
  const visible: VisibleEdge[] = [];
  for (const dependency of incident) {
    const refs = timelineEdgeRefs(dependency);
    const start = endpoints.get(refKey(refs.start));
    const target = endpoints.get(refKey(refs.target));
    if (start && target) {
      visible.push({ dependency, start: pointFor(start), target: pointFor(target) });
    }
  }

  const overlay = document.createElement("div");
  overlay.className = "timeline-deps-overlay";
  const svg = svgEl("svg");
  svg.setAttribute("class", "timeline-deps-svg");
  svg.setAttribute("aria-hidden", "true");
  const width = Math.ceil(Math.max(lanes.scrollWidth, origin.width));
  const height = Math.ceil(Math.max(lanes.scrollHeight, origin.height));
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const defs = svgEl("defs");
  defs.append(
    marker("timeline-dep-arrow", "timeline-dep-arrow"),
    marker("timeline-dep-arrow-conflict", "timeline-dep-arrow dep-conflict"),
  );
  const edges = svgEl("g");
  edges.setAttribute("class", "timeline-dep-edges");
  const arrows = svgEl("g");
  arrows.setAttribute("class", "timeline-dep-arrows");
  svg.append(defs, edges, arrows);

  const conflicts = state.dependencyAnalysis().conflictingEdges;
  visible.forEach((edge) => {
    addPath(edges, arrows, edge, conflicts.has(edge.dependency.id));
  });

  // Attach before placing a note so the badge's laid-out width is available.
  overlay.append(svg);
  lanes.append(overlay);
  const hidden = incident.length - visible.length;
  const centerPoint = pointFor(center);
  if (incident.length === 0) noteAt(overlay, centerPoint, "No dependencies");
  else if (hidden > 0) {
    noteAt(
      overlay,
      centerPoint,
      `${hidden} connection${hidden === 1 ? "" : "s"} hidden by the current view`,
    );
  }
}
