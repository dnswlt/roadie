// Pure logic over the dependency edge list, DOM-free so deps-graph.test.ts can
// pin it. The model keeps edges as one flat roadmap-level list ("to needs
// from"); everything a view wants — per-entity adjacency, the local
// neighborhood, date sanity — is derived here.

import type { Dependency, DependencyRef, LaneFull, RoadmapFull } from "./types";

export function sameRef(a: DependencyRef, b: DependencyRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

// refKey collapses a ref into a map/set key. Items and milestones share the
// graph but not an id space, so the kind is part of the key.
export function refKey(ref: DependencyRef): string {
  return `${ref.kind}:${ref.id}`;
}

// splitDeps returns the edges touching one entity, by direction: `dependsOn`
// holds the edges where it is the dependent (its prerequisites are on the far
// end), `neededBy` those where it is the prerequisite. These are the panel's
// two lists, and the two columns of the local graph.
export function splitDeps(
  deps: Dependency[],
  ref: DependencyRef,
  lanes: LaneFull[] = [],
): { dependsOn: Dependency[]; neededBy: Dependency[] } {
  const dependsOn: Dependency[] = [];
  const neededBy: Dependency[] = [];
  for (const d of deps) {
    if (sameRef(d.to, ref)) dependsOn.push(d);
    else if (sameRef(d.from, ref)) neededBy.push(d);
  }
  // The roadmap payload is already in its canonical display order: lanes by
  // position; milestones by date; items by rank, with each parent's ranked
  // children directly after it. Match the WBS's milestone-group-then-items
  // projection so dependency lists do not expose incidental edge creation ids.
  const order = new Map<string, number>();
  let position = 0;
  for (const lane of lanes) {
    for (const milestone of lane.milestones) order.set(refKey({ kind: "milestone", id: milestone.id }), position++);
    for (const item of lane.items) {
      order.set(refKey({ kind: "item", id: item.id }), position++);
      for (const child of item.children) order.set(refKey({ kind: "item", id: child.id }), position++);
    }
  }
  const at = (endpoint: (d: Dependency) => DependencyRef) => (a: Dependency, b: Dependency): number =>
    (order.get(refKey(endpoint(a))) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(refKey(endpoint(b))) ?? Number.MAX_SAFE_INTEGER);
  dependsOn.sort(at((d) => d.from));
  neededBy.sort(at((d) => d.to));
  return { dependsOn, neededBy };
}

// What one entity's edges add up to: how many touch it in each direction, and
// how many of those the calendar contradicts. This is what the chart's small
// per-item mark is drawn from — presence, and whether presence is a problem.
export interface DepSummary {
  dependsOn: number;
  neededBy: number;
  conflicts: number;
}

// The dates an entity occupies. A milestone has no duration, so its single
// date stands as both of its ends: nothing may finish after it, and it starts
// when it lands. That rule lives here and nowhere else — it decides both
// whether an edge is met and whether a card prints one date or a range.
export interface EntitySpan {
  start: string;
  end: string;
}

// Everything the views need to know about the dependency graph, in the two
// shapes they ask for it: per entity (the chart's mark) and per edge (the
// overlay's tinting).
export interface DependencyAnalysis {
  // Only entities that have edges appear in `summaries`, so a missing entry
  // *is* "draw no mark".
  summaries: Map<string, DepSummary>;
  // Edge ids whose endpoints' dates contradict the dependency.
  conflictingEdges: Set<number>;
  // Every entity's span, including those with no edges — the overlay prints
  // dates for whatever it draws.
  spans: Map<string, EntitySpan>;
}

// analyzeDependencies is the single pass over the roadmap's edges, and the one
// place that turns a DependencyRef into dates.
//
// The node-level and edge-level answers are both real projections — the chart
// marks entities, the overlay tints edges — but deriving them separately meant
// two endpoint-resolution paths that happened to agree, one walking lanes and
// one going through state.findItem/findMilestone. Both encoded "a milestone's
// date is both its ends", and both decided independently what a vanished
// endpoint means. Sharing dateConflict was not enough: the inputs to it could
// drift. So resolution, stale-endpoint policy and conflict semantics live here
// once, and the callers pick the projection they need.
//
// Cheap enough to run per render pass: one walk of the lanes to index spans,
// one walk of the edges.
export function analyzeDependencies(rm: RoadmapFull | null): DependencyAnalysis {
  const summaries = new Map<string, DepSummary>();
  const conflictingEdges = new Set<number>();
  const spans = new Map<string, EntitySpan>();
  if (!rm) return { summaries, conflictingEdges, spans };

  for (const lane of rm.lanes) {
    for (const item of lane.items) {
      spans.set(refKey({ kind: "item", id: item.id }), { start: item.startDate, end: item.endDate });
      for (const child of item.children) {
        spans.set(refKey({ kind: "item", id: child.id }), { start: child.startDate, end: child.endDate });
      }
    }
    for (const ms of lane.milestones) {
      spans.set(refKey({ kind: "milestone", id: ms.id }), { start: ms.date, end: ms.date });
    }
  }

  const entryOf = (key: string): DepSummary => {
    let e = summaries.get(key);
    if (!e) {
      e = { dependsOn: 0, neededBy: 0, conflicts: 0 };
      summaries.set(key, e);
    }
    return e;
  };

  for (const d of rm.dependencies) {
    const fromKey = refKey(d.from);
    const toKey = refKey(d.to);
    const from = spans.get(fromKey);
    const to = spans.get(toKey);
    // An edge whose endpoint vanished under an SSE refresh counts for nothing,
    // in either projection; the next refetch drops the edge itself.
    if (!from || !to) continue;
    entryOf(toKey).dependsOn++;
    entryOf(fromKey).neededBy++;
    if (dateConflict(from.end, to.start)) {
      conflictingEdges.add(d.id);
      // The contradiction belongs to the pair, not to one end of it, so both
      // carry it: a late prerequisite is as visible from the work it blocks as
      // from itself, which is what makes the warning findable while scanning.
      entryOf(fromKey).conflicts++;
      entryOf(toKey).conflicts++;
    }
  }
  return { summaries, conflictingEdges, spans };
}

// linkedRefs returns the set of refKeys already connected to `ref` in either
// direction. The add-dropdown excludes these: re-adding an existing edge or
// directly reversing one is a guaranteed rejection, so it is not offered.
export function linkedRefs(deps: Dependency[], ref: DependencyRef): Set<string> {
  const linked = new Set<string>();
  for (const d of deps) {
    if (sameRef(d.to, ref)) linked.add(refKey(d.from));
    else if (sameRef(d.from, ref)) linked.add(refKey(d.to));
  }
  return linked;
}

// dateConflict reports whether an edge contradicts the calendar: the
// prerequisite is scheduled to end after the dependent begins (an item's
// start, a milestone's date). With no done/completed state in the model, this
// is the one dependency health signal derivable from dates alone. Strictly
// after: finishing on the very day the dependent starts (or the milestone
// falls) is a handover, not a conflict. ISO date strings compare
// lexicographically.
export function dateConflict(fromEnd: string, toStart: string): boolean {
  return fromEnd > toStart;
}
