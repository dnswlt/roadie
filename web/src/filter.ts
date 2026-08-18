// Pure item filtering for the label/flag filter menu. Both chart projections
// consume the same projected lane so hierarchy behaves identically in the
// timeline and WBS: direct matches stay, a non-matching parent stays only when
// one of its children matches, and all other items disappear.

import type { Item, ItemFull, LaneFull } from "./types";

// What the filter menu is filtering to: a set of labels, or one of the two
// built-in attention signals. A tagged union keeps a user's label literally
// named "flagged" distinct from the flag itself. A labels filter is non-empty;
// no active filter is represented by null.
export type Filter =
  | { kind: "labels"; labels: string[] }
  | { kind: "flagged" }
  | { kind: "atRisk" };

// matchesFilter is true for every item when no filter is active. Several label
// picks match as OR: adding a label widens the result set.
export function matchesFilter(item: Item, filter: Filter | null): boolean {
  if (filter === null) return true;
  if (filter.kind === "flagged") return item.flagged;
  if (filter.kind === "atRisk") return item.atRisk;
  return filter.labels.some((label) => item.labels.includes(label));
}

// An item move resolves its drop into a rank by counting rendered siblings
// (dnd.ts's indexFromY), so "DOM order is rank order" has to hold — and it only
// holds on an unfiltered render. Moves therefore pause while filtering, rather
// than writing a rank counted over a subset. Resize handles are different: they
// edit one explicit date boundary and infer no structure from the drop.
export function canDrag(filter: Filter | null, gesture: "move" | "resize"): boolean {
  return filter === null || gesture === "resize";
}

// What a swallowed move says for itself. Both controllers show this one, from
// here rather than from each other: a gesture that is silently ignored reads as
// a broken chart instead of a rule.
export const DRAG_BLOCKED_HINT = "Clear the filter to rearrange items";

// filterItems preserves roadmap order and rank values. It does not mutate the
// model: kept parents are shallow copies whose children contain only direct
// matches. A child match retains its parent as the hierarchy breadcrumb even
// when the parent is not itself a match.
export function filterItems(items: ItemFull[], filter: Filter | null): ItemFull[] {
  if (filter === null) return items;
  const out: ItemFull[] = [];
  for (const item of items) {
    const children = item.children.filter((child) => matchesFilter(child, filter));
    if (matchesFilter(item, filter) || children.length > 0) out.push({ ...item, children });
  }
  return out;
}

// filterLane deliberately never removes the lane itself. Milestones are not
// item-filter candidates and remain as calendar landmarks; a lane with no
// matching items therefore renders exactly like an otherwise empty lane.
export function filterLane(lane: LaneFull, filter: Filter | null): LaneFull {
  if (filter === null) return lane;
  return { ...lane, items: filterItems(lane.items, filter) };
}

// hasMatch answers the chart's "did anything survive" question, so an empty
// result can say so instead of looking like a roadmap that lost its items. It
// is asked over the lanes about to be drawn, not the whole roadmap: a match
// sitting in a hidden context is not on screen either.
export function hasMatch(lanes: LaneFull[], filter: Filter | null): boolean {
  if (filter === null) return true;
  return lanes.some((lane) =>
    lane.items.some(
      (item) => matchesFilter(item, filter) || item.children.some((c) => matchesFilter(c, filter)),
    ),
  );
}
