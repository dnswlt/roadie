import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canDrag, filterItems, filterLane, hasMatch, matchesFocus, type Focus } from "./focus";
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

function ids(items: ItemFull[]): Array<[number, number[]]> {
  return items.map((parent) => [parent.id, parent.children.map((child) => child.id)]);
}

test("no focus preserves the original item array", () => {
  const items = [item(1, ["a"]), item(2)];
  assert.equal(filterItems(items, null), items);
  assert.equal(matchesFocus(items[1]!, null), true);
});

test("label filtering keeps direct matches and matching labels combine as OR", () => {
  const focus: Focus = { kind: "labels", labels: ["a", "b"] };
  const items = [item(1, ["a"]), item(2, ["b", "c"]), item(3, ["c"]), item(4)];
  assert.deepEqual(ids(filterItems(items, focus)), [
    [1, []],
    [2, []],
  ]);
});

test("a matching child keeps its non-matching parent and filters its siblings", () => {
  const matching = item(2, ["keep"]);
  const hidden = item(3, ["other"]);
  const parent = item(1, [], false, [matching, hidden]);
  const result = filterItems([parent, item(4)], { kind: "labels", labels: ["keep"] });

  assert.deepEqual(ids(result), [[1, [2]]]);
  assert.equal(matchesFocus(result[0]!, { kind: "labels", labels: ["keep"] }), false);
  assert.equal(parent.children.length, 2, "the roadmap model is not mutated");
});

test("a matching parent does not retain children that do not match", () => {
  const parent = item(1, ["keep"], false, [item(2, ["other"]), item(3, ["keep"])]);
  assert.deepEqual(ids(filterItems([parent], { kind: "labels", labels: ["keep"] })), [[1, [3]]]);
});

test("flagged and at-risk focuses remain independent", () => {
  const items = [item(1, [], true), item(2, [], false, [], true), item(3, [], true, [], true)];
  assert.deepEqual(ids(filterItems(items, { kind: "flagged" })), [
    [1, []],
    [3, []],
  ]);
  assert.deepEqual(ids(filterItems(items, { kind: "atRisk" })), [
    [2, []],
    [3, []],
  ]);
});

test("an empty filtered lane remains present with its milestones", () => {
  const milestone: Milestone = {
    id: 9,
    laneId: 1,
    title: "M",
    description: "",
    date: "2026-01-01",
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
  const result = filterLane(lane, { kind: "labels", labels: ["keep"] });
  assert.deepEqual(result.items, []);
  assert.equal(result.milestones[0], milestone);
});

test("item moves pause while filtering but timeline resizing remains available", () => {
  const focus: Focus = { kind: "flagged" };
  assert.equal(canDrag(null, "move"), true);
  assert.equal(canDrag(null, "resize"), true);
  assert.equal(canDrag(focus, "move"), false);
  assert.equal(canDrag(focus, "resize"), true);
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
  const focus: Focus = { kind: "labels", labels: ["keep"] };
  assert.equal(hasMatch([laneOf([item(1, ["keep"])])], focus), true);
  assert.equal(hasMatch([laneOf([item(1, [], false, [item(2, ["keep"])])])], focus), true);
  assert.equal(hasMatch([laneOf([item(1, ["other"])])], focus), false);
  // Without a filter the question does not arise: nothing is ever filtered out.
  assert.equal(hasMatch([laneOf([])], null), true);
});
