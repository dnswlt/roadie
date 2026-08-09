// Pure logic over the dependency edge list, DOM-free so deps-graph.test.ts can
// pin it. The model keeps edges as one flat roadmap-level list ("to needs
// from"); everything a view wants — per-entity adjacency, the local
// neighborhood, date sanity — is derived here.

import type { Dependency, DependencyRef, LaneFull } from "./types";

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
