import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  canDrag,
  filterItems,
  filterLane,
  itemPredicate,
  project,
  type Filter,
} from "./filter";
import type { ItemFull, LaneFull, Milestone } from "./types";

function item(
  id: number,
  labels: string[] = [],
  flagged = false,
  children: ItemFull[] = [],
  atRisk = false,
): ItemFull {
  return {
    id,
    laneId: 1,
    parentId: null,
    title: `i${id}`,
    description: "",
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    rank: id,
    priority: null,
    labels,
    flagged,
    tentative: false,
    atRisk,
    children,
  };
}

// Every caller reaches a filter through its predicate, so the tests do too.
function match(filter: Filter | null) {
  return itemPredicate(filter, new Set());
}

function ids(items: ItemFull[]): Array<[number, number[]]> {
  return items.map((parent) => [parent.id, parent.children.map((child) => child.id)]);
}

// No filter is a null predicate rather than one that answers true, so the
// projection can hand back the roadmap's own arrays untouched.
test("no filter preserves the original item array", () => {
  const items = [item(1, ["a"]), item(2)];
  assert.equal(itemPredicate(null, new Set()), null);
  assert.equal(filterItems(items, null), items);
});

test("label filtering keeps direct matches and matching labels combine as OR", () => {
  const filter: Filter = { kind: "labels", labels: ["a", "b"] };
  const items = [item(1, ["a"]), item(2, ["b", "c"]), item(3, ["c"]), item(4)];
  assert.deepEqual(ids(filterItems(items, match(filter))), [
    [1, []],
    [2, []],
  ]);
});

test("a matching child keeps its non-matching parent and filters its siblings", () => {
  const matching = item(2, ["keep"]);
  const hidden = item(3, ["other"]);
  const parent = item(1, [], false, [matching, hidden]);
  const result = filterItems([parent, item(4)], match({ kind: "labels", labels: ["keep"] }));

  assert.deepEqual(ids(result), [[1, [2]]]);
  assert.equal(match({ kind: "labels", labels: ["keep"] })!(result[0]!), false);
  assert.equal(parent.children.length, 2, "the roadmap model is not mutated");
});

test("a matching parent does not retain children that do not match", () => {
  const parent = item(1, ["keep"], false, [item(2, ["other"]), item(3, ["keep"])]);
  assert.deepEqual(ids(filterItems([parent], match({ kind: "labels", labels: ["keep"] }))), [[1, [3]]]);
});

test("flagged and at-risk focuses remain independent", () => {
  const items = [item(1, [], true), item(2, [], false, [], true), item(3, [], true, [], true)];
  assert.deepEqual(ids(filterItems(items, match({ kind: "flagged" }))), [
    [1, []],
    [3, []],
  ]);
  assert.deepEqual(ids(filterItems(items, match({ kind: "atRisk" }))), [
    [2, []],
    [3, []],
  ]);
});

test("dependency-conflict focus uses derived item membership and keeps breadcrumbs", () => {
  const parent = item(1, [], false, [item(2), item(3)]);
  // Conflict membership arrives as a set: it is derived from the graph, not
  // read off the item, which is why Filter itself carries nothing.
  const pred = itemPredicate({ kind: "dependencyConflicts" }, new Set([2, 4]))!;

  assert.deepEqual(ids(filterItems([parent, item(4), item(5)], pred)), [
    [1, [2]],
    [4, []],
  ]);
  assert.equal(pred(parent), false);
});

test("an empty filtered lane remains present with its milestones", () => {
  const milestone: Milestone = {
    id: 9,
    uid: "uid-m9",
    laneId: 1,
    title: "M",
    description: "",
    date: "2026-01-01",
    tentative: false,
  };
  const lane: LaneFull = {
    id: 1,
    roadmapId: 1,
    name: "Lane",
    position: 0,
    color: "blue",
    items: [item(1, ["other"])],
    milestones: [milestone],
  };
  const result = filterLane(lane, match({ kind: "labels", labels: ["keep"] }));
  assert.deepEqual(result.items, []);
  assert.equal(result.milestones[0], milestone);
});

test("item moves pause while filtering but timeline resizing remains available", () => {
  const filter: Filter = { kind: "flagged" };
  assert.equal(canDrag(null, "move"), true);
  assert.equal(canDrag(null, "resize"), true);
  assert.equal(canDrag(filter, "move"), false);
  assert.equal(canDrag(filter, "resize"), true);
});

test("hasMatch sees a lane's own match, a child's match, and neither", () => {
  const laneOf = (items: ItemFull[]): LaneFull => ({
    id: 1,
    roadmapId: 1,
    name: "Lane",
    position: 0,
    color: "blue",
    items,
    milestones: [],
  });
  const keep = match({ kind: "labels", labels: ["keep"] });
  const drawn = (lanes: LaneFull[], m = keep, folded = false) =>
    project(lanes, {
      isLaneHidden: () => false,
      isFolded: () => folded,
      match: m,
    }).drawnItemIds;

  assert.deepEqual([...drawn([laneOf([item(1, ["keep"])])])], [1]);
  // A breadcrumb parent is drawn, and so is the child that earned it.
  assert.deepEqual([...drawn([laneOf([item(1, [], false, [item(2, ["keep"])])])])], [1, 2]);
  assert.equal(drawn([laneOf([item(1, ["other"])])]).size, 0);

  // A folded parent's children stay in the lane but are not drawn — the
  // distinction selection, snapping and zoom all depend on.
  const folded = [laneOf([item(1, ["keep"], false, [item(2, ["keep"])])])];
  assert.deepEqual([...drawn(folded, keep, true)], [1]);
  assert.deepEqual([...drawn(folded, keep, false)], [1, 2]);
});

test("a hidden context contributes neither lanes nor drawn items", () => {
  const lane: LaneFull = {
    id: 7,
    roadmapId: 1,
    name: "Hidden",
    position: 0,
    color: "blue",
    items: [item(1)],
    milestones: [],
  };
  const p = project([lane], { isLaneHidden: () => true, isFolded: () => false, match: null });
  assert.deepEqual(p.lanes, []);
  assert.equal(p.drawnItemIds.size, 0);
});
