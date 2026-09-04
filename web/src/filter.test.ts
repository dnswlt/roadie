import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  canDrag,
  filterPredicate,
  filterItems,
  filterLane,
  itemFacts,
  milestoneFacts,
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

function milestone(id: number): Milestone {
  return {
    id,
    uid: `uid-m${id}`,
    laneId: 1,
    title: `m${id}`,
    description: "",
    date: "2026-01-01",
    tentative: false,
  };
}

// Every caller reaches a filter through its predicate, so the tests do too.
function match(filter: Filter | null) {
  return filterPredicate(filter, new Set());
}

function ids(items: ItemFull[]): Array<[number, number[]]> {
  return items.map((parent) => [parent.id, parent.children.map((child) => child.id)]);
}

// No filter is a null predicate rather than one that answers true, so the
// projection can hand back the roadmap's own arrays untouched.
test("no filter preserves the original item array", () => {
  const items = [item(1, ["a"]), item(2)];
  assert.equal(filterPredicate(null, new Set()), null);
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

test("inverted label filters match neither selected label, including unlabeled items", () => {
  const filter: Filter = { kind: "labels", labels: ["needs-refinement", "refined"], inverted: true };
  const items = [
    item(1, ["needs-refinement"]),
    item(2, ["refined", "@team"]),
    item(3, ["needs-refinement", "refined"]),
    item(4, ["@team"]),
    item(5),
  ];
  assert.deepEqual(ids(filterItems(items, match(filter))), [[4, []], [5, []]]);
});

test("inversion applies before retaining parent breadcrumbs", () => {
  const parent = item(1, ["refined"], false, [item(2), item(3, ["refined"])]);
  const pred = match({ kind: "labels", labels: ["refined"], inverted: true })!;
  assert.deepEqual(ids(filterItems([parent], pred)), [[1, [2]]]);
  assert.equal(pred(itemFacts(parent)), false);
  assert.equal(parent.children.length, 2);
});

test("each signal filter can be inverted independently", () => {
  const items = [item(1, [], true), item(2, [], false, [], true), item(3)];
  for (const [kind, expected] of [
    ["flagged", [2, 3]],
    ["atRisk", [1, 3]],
    ["dependencyConflicts", [1, 2]],
  ] as const) {
    const pred = filterPredicate({ kind, inverted: true }, new Set(["item:3"]))!;
    assert.deepEqual(items.filter((i) => pred(itemFacts(i))).map(i => i.id), expected, kind);
  }
});

test("an inverted filter with no positive matches matches every entity", () => {
  assert.equal(match({ kind: "labels", labels: ["gone"], inverted: true })!(itemFacts(item(1))), true);
  assert.equal(match({ kind: "flagged", inverted: true })!(itemFacts(item(1))), true);
  assert.equal(match({ kind: "dependencyConflicts", inverted: true })!(itemFacts(item(1))), true);
  assert.equal(
    match({ kind: "labels", labels: ["gone"], inverted: true })!(milestoneFacts(milestone(1))),
    true,
  );
});

test("a matching child keeps its non-matching parent and filters its siblings", () => {
  const matching = item(2, ["keep"]);
  const hidden = item(3, ["other"]);
  const parent = item(1, [], false, [matching, hidden]);
  const result = filterItems([parent, item(4)], match({ kind: "labels", labels: ["keep"] }));

  assert.deepEqual(ids(result), [[1, [2]]]);
  assert.equal(match({ kind: "labels", labels: ["keep"] })!(itemFacts(result[0]!)), false);
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
  const pred = filterPredicate(
    { kind: "dependencyConflicts" },
    new Set(["item:2", "item:4"]),
  )!;

  assert.deepEqual(ids(filterItems([parent, item(4), item(5)], pred)), [
    [1, [2]],
    [4, []],
  ]);
  assert.equal(pred(itemFacts(parent)), false);
});

test("a filter removes non-matching milestones but preserves their lane", () => {
  const ms = milestone(9);
  const lane: LaneFull = {
    id: 1,
    roadmapId: 1,
    name: "Lane",
    position: 0,
    color: "blue",
    items: [item(1, ["other"])],
    milestones: [ms],
  };
  const result = filterLane(lane, match({ kind: "labels", labels: ["keep"] }));
  assert.equal(result.id, lane.id);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.milestones, []);
  assert.equal(
    filterLane(lane, match({ kind: "labels", labels: ["keep"], inverted: true }))
      .milestones[0],
    ms,
  );
});

test("milestones can match dependency conflicts but not item-only metadata", () => {
  const ms = milestone(9);
  assert.equal(match({ kind: "labels", labels: ["keep"] })!(milestoneFacts(ms)), false);
  assert.equal(match({ kind: "flagged" })!(milestoneFacts(ms)), false);
  assert.equal(match({ kind: "atRisk" })!(milestoneFacts(ms)), false);

  const conflicts = filterPredicate(
    { kind: "dependencyConflicts" },
    new Set(["milestone:9"]),
  )!;
  assert.equal(conflicts(milestoneFacts(ms)), true);
  assert.equal(
    conflicts(itemFacts(item(9))),
    false,
    "item and milestone ids are separate spaces",
  );
});

test("item moves pause while filtering but timeline resizing remains available", () => {
  const filter: Filter = { kind: "flagged" };
  assert.equal(canDrag(null, "move"), true);
  assert.equal(canDrag(null, "resize"), true);
  assert.equal(canDrag(filter, "move"), false);
  assert.equal(canDrag(filter, "resize"), true);
  assert.equal(canDrag({ ...filter, inverted: true }, "move"), false);
  assert.equal(canDrag({ ...filter, inverted: true }, "resize"), true);
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
  assert.equal(p.drawnMilestoneIds.size, 0);
});
