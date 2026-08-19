// The chart projection: what the timeline and the WBS actually draw, which is
// the roadmap minus what three things hide — a hidden context, a folded
// parent, an active item filter. It is derived once (state.projection()) and
// handed out; a reader that rebuilds the rule by hand is a copy that drifts.
//
// Both views consume the same projected lane, so hierarchy behaves identically
// in each: direct matches stay, a non-matching parent stays only when one of
// its children matches, everything else disappears.

import type { Item, ItemFull, LaneFull } from "./types";

// What the filter menu is filtering to: a set of labels, or one built-in
// attention signal. A tagged union keeps a user's label literally named
// "flagged" distinct from the flag itself. A labels filter is non-empty; no
// filter at all is null. Nothing derived is stored here — conflict membership
// is resolved where the projection is built — so a Filter cannot go stale.
export type Filter =
  | { readonly kind: "labels"; readonly labels: readonly string[] }
  | { readonly kind: "flagged" }
  | { readonly kind: "atRisk" }
  | { readonly kind: "dependencyConflicts" };

export type SignalFilterKind = Exclude<Filter["kind"], "labels">;

// Whether one item matches the filter, ignoring the breadcrumb rule. Null is
// "no filter", so callers skip the work instead of running a predicate that
// always says yes.
export type ItemMatch = (item: Item) => boolean;

// itemPredicate turns a Filter into that test. Conflict membership is the one
// kind that cannot be read off the item, so it arrives as a set from the
// dependency graph.
export function itemPredicate(
  filter: Filter | null,
  conflictItemIds: ReadonlySet<number>,
): ItemMatch | null {
  if (filter === null) return null;
  switch (filter.kind) {
    case "flagged":
      return (item) => item.flagged;
    case "atRisk":
      return (item) => item.atRisk;
    case "dependencyConflicts":
      return (item) => conflictItemIds.has(item.id);
    case "labels":
      // Several label picks match as OR: adding a label widens the result.
      return (item) => filter.labels.some((label) => item.labels.includes(label));
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
export function filterItems(items: ItemFull[], match: ItemMatch | null): ItemFull[] {
  if (match === null) return items;
  const out: ItemFull[] = [];
  for (const item of items) {
    const children = item.children.filter(match);
    if (match(item) || children.length > 0) out.push({ ...item, children });
  }
  return out;
}

// filterLane deliberately never removes the lane itself. Milestones are not
// item-filter candidates and remain as calendar landmarks; a lane with no
// matching items therefore renders exactly like an otherwise empty lane.
export function filterLane(lane: LaneFull, match: ItemMatch | null): LaneFull {
  if (match === null) return lane;
  return { ...lane, items: filterItems(lane.items, match) };
}

// What is on screen, in the two forms callers need: `lanes` to draw from, and
// `drawnItemIds` to ask about one id.
//
// They differ by folds. A folded parent's children stay in `lanes` — the WBS
// needs them to know it has something to unfold, and the timeline's layout
// drops them itself — but they are not drawn, so they are absent from
// `drawnItemIds`, which is what selection, snapping and zoom respect.
export interface Projection {
  lanes: LaneFull[];
  drawnItemIds: ReadonlySet<number>;
  matches: ItemMatch;
}

// `isFolded` is supplied rather than decided here: whether a fold is honoured
// depends on the filter — an active one suspends folds, since every surviving
// child is a match — and that rule lives in state.
export function project(
  lanes: LaneFull[],
  opts: {
    isLaneHidden: (laneId: number) => boolean;
    isFolded: (itemId: number) => boolean;
    match: ItemMatch | null;
  },
): Projection {
  const out: LaneFull[] = [];
  const drawnItemIds = new Set<number>();
  for (const lane of lanes) {
    if (opts.isLaneHidden(lane.id)) continue;
    const projected = filterLane(lane, opts.match);
    out.push(projected);
    for (const item of projected.items) {
      drawnItemIds.add(item.id);
      if (opts.isFolded(item.id)) continue;
      for (const child of item.children) drawnItemIds.add(child.id);
    }
  }
  return { lanes: out, drawnItemIds, matches: opts.match ?? (() => true) };
}
