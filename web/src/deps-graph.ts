// Pure logic over the dependency edge list, DOM-free so deps-graph.test.ts can
// pin it. The model keeps edges as one flat roadmap-level list ("to needs
// from"); everything a view wants — per-entity adjacency, the local
// neighborhood, date sanity — is derived here.

import type { Dependency, DependencyRef } from "./types";

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
): { dependsOn: Dependency[]; neededBy: Dependency[] } {
  const dependsOn: Dependency[] = [];
  const neededBy: Dependency[] = [];
  for (const d of deps) {
    if (sameRef(d.to, ref)) dependsOn.push(d);
    else if (sameRef(d.from, ref)) neededBy.push(d);
  }
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
