// Moving the selected item one place up or down among its siblings: the
// keyboard twin of a vertical drag, without the structure a drag can also
// change. An item's siblings are its context's top-level items or its parent's
// children, and a move stays inside that list — a child never leaves its
// parent, a top-level item never changes context.
//
// Both views stack items in list order and rank == array index, so one step is
// one row on screen in the timeline and in the WBS alike. That equivalence is
// also why the move is refused under a filter: with non-matches gone from the
// rows but still in the list, a step would jump what it cannot see.

import { actions } from "./actions";
import { canDrag, DRAG_BLOCKED_HINT } from "./filter";
import { state, type ItemLocation } from "./state";
import { toast } from "./toast";

export type Direction = "up" | "down";

// stepRank resolves the rank an item takes after one step, or null when it is
// already at that end of its list. DOM-free, so the position algebra is pinned
// by reorder.test.ts rather than by pressing keys.
export function stepRank(loc: ItemLocation, dir: Direction): number | null {
  const siblings = loc.parent ? loc.parent.children : loc.lane.items;
  const index = siblings.findIndex((i) => i.id === loc.item.id);
  const next = index + (dir === "up" ? -1 : 1);
  return next < 0 || next >= siblings.length ? null : next;
}

// One move at a time. Key repeat would otherwise leave a burst of PATCHes in
// flight, each holding an optimistic rollback older than the moves that
// followed it; dropping the repeats paces moves to the round trip instead.
let moving = false;

// moveSelection is the Alt+Arrow command. Everything it declines is a silent
// no-op except a move the filter forbids, which says so: a key that does
// nothing reads as a broken key.
export function moveSelection(dir: Direction): void {
  if (moving) return;
  if (state.navigation.view === "recon") return;
  // Null for a milestone (they have no rank), for several items (their ranks
  // are counted in different lists), and for no selection at all.
  const id = state.selectedItemId;
  if (id === null) return;
  if (!canDrag(state.filter, "move")) {
    toast(DRAG_BLOCKED_HINT);
    return;
  }
  const loc = state.findItem(id);
  if (!loc) return;
  const rank = stepRank(loc, dir);
  if (rank === null) return;
  moving = true;
  // The item travels one row, so the chart should follow only when it would
  // otherwise leave the viewport.
  state.scrollToSelection = "nearest";
  void actions.updateItem(id, { rank }).finally(() => {
    moving = false;
  });
}
