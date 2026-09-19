import { strict as assert } from "node:assert";
import { test } from "node:test";
import { stepRank } from "./reorder";
import type { ItemLocation } from "./state";
import type { ItemFull, LaneFull } from "./types";

// Fixtures carry only what stepRank reads: the two container arrays and the
// item's id. Every other field gets a throwaway value.
function item(id: number, children: ItemFull[] = []): ItemFull {
  return {
    id,
    laneId: 1,
    parentId: null,
    title: `i${id}`,
    description: "",
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    rank: 0,
    priority: null,
    labels: [],
    flagged: false,
    tentative: false,
    atRisk: false,
    children,
  };
}

function lane(items: ItemFull[]): LaneFull {
  return { id: 1, roadmapId: 1, name: "Lane", color: "blue", position: 0, items, milestones: [] };
}

// A location as state.findItem builds one: `parent` is what decides which list
// the item is ranked in.
function at(items: ItemFull[], index: number): ItemLocation {
  return { item: items[index]!, lane: lane(items), parent: null };
}

function childAt(parent: ItemFull, index: number): ItemLocation {
  return { item: parent.children[index]!, lane: lane([parent]), parent };
}

test("a top-level item steps through its context's items", () => {
  const items = [item(1), item(2), item(3)];
  assert.equal(stepRank(at(items, 1), "up"), 0);
  assert.equal(stepRank(at(items, 1), "down"), 2);
});

test("a top-level item stops at both ends of its context", () => {
  const items = [item(1), item(2), item(3)];
  assert.equal(stepRank(at(items, 0), "up"), null);
  assert.equal(stepRank(at(items, 2), "down"), null);
});

test("a child steps through its parent's children", () => {
  const parent = item(1, [item(10), item(11), item(12)]);
  assert.equal(stepRank(childAt(parent, 1), "up"), 0);
  assert.equal(stepRank(childAt(parent, 1), "down"), 2);
});

// The rule the feature rests on: a child is ranked among its siblings, never
// among the lane's items, so it cannot step out of its parent at either end.
test("a child stops at both ends of its parent", () => {
  const parent = item(1, [item(10), item(11)]);
  assert.equal(stepRank(childAt(parent, 0), "up"), null);
  assert.equal(stepRank(childAt(parent, 1), "down"), null);
});

test("an only child has nowhere to go", () => {
  const parent = item(1, [item(10)]);
  assert.equal(stepRank(childAt(parent, 0), "up"), null);
  assert.equal(stepRank(childAt(parent, 0), "down"), null);
});
