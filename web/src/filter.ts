// The chart projection: what the timeline and the WBS actually draw, which is
// the roadmap minus what three things hide — a hidden context, a folded
// parent, an active filter. It is derived once (state.projection()) and
// handed out; a reader that rebuilds the rule by hand is a copy that drifts.
//
// Both views consume the same projected lane, so hierarchy behaves identically
// in each: direct matches stay, a non-matching parent stays only when one of
// its children matches, everything else disappears.

import { refKey } from "./deps-graph";
import type { Item, ItemFull, LaneFull, Milestone } from "./types";

// What the filter menu is filtering to: a set of labels, or one built-in
// attention signal. A tagged union keeps a user's label literally named
// "flagged" distinct from the flag itself. A labels filter is non-empty; no
// filter at all is null. Nothing derived is stored here — conflict membership
// is resolved where the projection is built — so a Filter cannot go stale.
export type Filter = { readonly inverted?: boolean } & (
  | { readonly kind: "labels"; readonly labels: readonly string[] }
  | { readonly kind: "flagged" }
  | { readonly kind: "atRisk" }
  | { readonly kind: "dependencyConflicts" }
);

export type SignalFilterKind = Exclude<Filter["kind"], "labels">;

// What the filter can ask about anything the chart draws. The adapters below
// keep entity kinds out of the predicate itself; both expose the same metadata
// while retaining kind-qualified dependency keys.
export interface Filterable {
  readonly key: string;
  readonly labels: readonly string[];
  readonly flagged: boolean;
  readonly atRisk: boolean;
}

export function itemFacts(item: Item): Filterable {
  return {
    key: refKey({ kind: "item", id: item.id }),
    labels: item.labels,
    flagged: item.flagged,
    atRisk: item.atRisk,
  };
}

export function milestoneFacts(milestone: Milestone): Filterable {
  return {
    key: refKey({ kind: "milestone", id: milestone.id }),
    labels: milestone.labels,
    flagged: milestone.flagged,
    atRisk: milestone.atRisk,
  };
}

// Whether one entity's filter facts match, ignoring the item breadcrumb rule.
// Null is "no filter", so callers skip the work instead of running a predicate
// that always says yes.
export type FilterMatch = (entity: Filterable) => boolean;

// filterPredicate turns a Filter into that test. Conflict membership is the
// one fact derived outside an entity, so it arrives as qualified dependency
// keys: item and milestone ids are separate id spaces.
export function filterPredicate(
  filter: Filter | null,
  conflictEntityKeys: ReadonlySet<string>,
): FilterMatch | null {
  if (filter === null) return null;
  const match = positivePredicate(filter, conflictEntityKeys);
  // Invert the combined match before projection retains parent breadcrumbs.
  return filter.inverted ? (entity) => !match(entity) : match;
}

function positivePredicate(
  filter: Filter,
  conflictEntityKeys: ReadonlySet<string>,
): FilterMatch {
  switch (filter.kind) {
    case "flagged":
      return (entity) => entity.flagged;
    case "atRisk":
      return (entity) => entity.atRisk;
    case "dependencyConflicts":
      return (entity) => conflictEntityKeys.has(entity.key);
    case "labels":
      // Several label picks match as OR: adding a label widens the result.
      return (entity) =>
        filter.labels.some((label) => entity.labels.includes(label));
  }
}

// An item move resolves its drop into a rank by counting rendered siblings
// (dnd.ts's indexFromY), so "DOM order is rank order" has to hold — and it only
// holds on an unfiltered render. Moves therefore pause while filtering, rather
// than writing a rank counted over a subset. Resize handles are different: they
// edit one explicit date boundary and infer no structure from the drop.
export function canDrag(filter: Filter | null, gesture: "move" | "resize"): boolean {
  return filter === null || gesture === "resize";
}

// What a swallowed move says for itself: a gesture that is silently ignored
// reads as a broken chart rather than a rule. Shared so both controllers word
// it identically.
export const DRAG_BLOCKED_HINT = "Clear the filter to rearrange items";

// filterItems preserves roadmap order and rank values. It does not mutate the
// model: kept parents are shallow copies whose children contain only direct
// matches. A child match retains its parent as the hierarchy breadcrumb even
// when the parent is not itself a match.
export function filterItems(items: ItemFull[], match: FilterMatch | null): ItemFull[] {
  if (match === null) return items;
  const out: ItemFull[] = [];
  for (const item of items) {
    const children = item.children.filter((child) => match(itemFacts(child)));
    if (match(itemFacts(item)) || children.length > 0) out.push({ ...item, children });
  }
  return out;
}

// filterLane deliberately never removes the lane itself. A lane with no
// matching entities therefore renders exactly like an otherwise empty lane.
export function filterLane(lane: LaneFull, match: FilterMatch | null): LaneFull {
  if (match === null) return lane;
  return {
    ...lane,
    items: filterItems(lane.items, match),
    milestones: lane.milestones.filter((milestone) => match(milestoneFacts(milestone))),
  };
}

// What is on screen, in the forms callers need: `lanes` to draw from, and one
// id set per entity kind for membership checks.
//
// A folded parent's children stay in `lanes` — the WBS needs them to know it
// has something to unfold, and the timeline's layout drops them itself — but
// they are absent from `drawnItemIds`, which selection and snapping respect.
// Milestones have no hierarchy, so their set is exactly their projected ids.
export interface Projection {
  lanes: LaneFull[];
  drawnItemIds: ReadonlySet<number>;
  drawnMilestoneIds: ReadonlySet<number>;
  matchesItem: (item: Item) => boolean;
  matchesMilestone: (milestone: Milestone) => boolean;
}

// `isFolded` is supplied rather than decided here: whether a fold is honoured
// depends on the filter — an active one suspends folds, since every surviving
// child is a match — and that rule lives in state.
export function project(
  lanes: LaneFull[],
  opts: {
    isLaneHidden: (laneId: number) => boolean;
    isFolded: (itemId: number) => boolean;
    match: FilterMatch | null;
  },
): Projection {
  const out: LaneFull[] = [];
  const drawnItemIds = new Set<number>();
  const drawnMilestoneIds = new Set<number>();
  for (const lane of lanes) {
    if (opts.isLaneHidden(lane.id)) continue;
    const projected = filterLane(lane, opts.match);
    out.push(projected);
    for (const milestone of projected.milestones) drawnMilestoneIds.add(milestone.id);
    for (const item of projected.items) {
      drawnItemIds.add(item.id);
      if (opts.isFolded(item.id)) continue;
      for (const child of item.children) drawnItemIds.add(child.id);
    }
  }
  const match = opts.match;
  return {
    lanes: out,
    drawnItemIds,
    drawnMilestoneIds,
    matchesItem: match ? (item) => match(itemFacts(item)) : () => true,
    matchesMilestone: match
      ? (milestone) => match(milestoneFacts(milestone))
      : () => true,
  };
}
