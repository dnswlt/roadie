import { strict as assert } from "node:assert";
import { test } from "node:test";
import { state } from "./state";
import type { ItemFull, LaneFull, RoadmapFull } from "./types";

// Minimal fixtures: the focus logic only reads labels and the flag, so every
// other field gets a throwaway value.
function item(id: number, labels: string[], flagged: boolean, children: ItemFull[] = []): ItemFull {
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
    labels,
    flagged,
    tentative: false,
    atRisk: false,
    children,
  };
}

// state's view preferences write through to localStorage, which node has no
// notion of. One in-memory stand-in for the whole file, installed before any
// test runs: a stub installed inside a test would outlive it and leave later
// tests with a half-implemented global.
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

function lane(id: number, items: ItemFull[] = []): LaneFull {
  return {
    id,
    roadmapId: 1,
    name: `L${id}`,
    position: id,
    color: "blue",
    items,
    milestones: [],
  };
}

function roadmapOf(lanes: LaneFull[]): RoadmapFull {
  return {
    id: 1,
    name: "R",
    createdAt: "2026-01-01T00:00:00Z",
    visibility: "public",
    lanes,
    periods: [],
    dependencies: [],
  };
}

function roadmap(items: ItemFull[]): RoadmapFull {
  return roadmapOf([lane(1, items)]);
}

test("no focus dims nothing", () => {
  state.focus = null;
  assert.equal(state.isDimmed(item(1, [], false)), false);
  assert.equal(state.isDimmed(item(2, ["a"], true)), false);
});

test("label focus dims items without that label", () => {
  state.focus = { kind: "labels", labels: ["a"] };
  assert.equal(state.isDimmed(item(1, ["a", "b"], false)), false);
  assert.equal(state.isDimmed(item(2, ["b"], false)), true);
  // A flagged item is not exempt: the two focus kinds are independent.
  assert.equal(state.isDimmed(item(3, [], true)), true);
});

// Several focused labels match as OR: adding one widens the spotlight.
test("multi-label focus dims items carrying none of the labels", () => {
  state.focus = { kind: "labels", labels: ["a", "b"] };
  assert.equal(state.isDimmed(item(1, ["a"], false)), false);
  assert.equal(state.isDimmed(item(2, ["b", "c"], false)), false);
  assert.equal(state.isDimmed(item(3, ["c"], false)), true);
  assert.equal(state.isDimmed(item(4, [], false)), true);
});

test("toggling labels builds and empties the focus", () => {
  state.focus = null;
  state.toggleFocusLabel("a");
  assert.deepEqual(state.focus, { kind: "labels", labels: ["a"] });
  state.toggleFocusLabel("b");
  assert.deepEqual(state.focus, { kind: "labels", labels: ["a", "b"] });
  assert.equal(state.isFocusedLabel("b"), true);

  // Alt-click narrows to one label, never back out — "Show all items" does that.
  state.isolateFocusLabel("b");
  assert.deepEqual(state.focus, { kind: "labels", labels: ["b"] });
  state.isolateFocusLabel("b");
  assert.deepEqual(state.focus, { kind: "labels", labels: ["b"] });

  // Un-picking the last label is the same state as no focus at all.
  state.toggleFocusLabel("b");
  assert.equal(state.focus, null);
  assert.equal(state.isFocusedLabel("b"), false);
});

// Labels and the flag are one exclusive field, so picking either drops the other.
test("picking a label replaces a flag focus", () => {
  state.focus = { kind: "flagged" };
  state.toggleFocusLabel("a");
  assert.deepEqual(state.focus, { kind: "labels", labels: ["a"] });
});

test("flag focus dims unflagged items regardless of labels", () => {
  state.focus = { kind: "flagged" };
  assert.equal(state.isDimmed(item(1, [], true)), false);
  assert.equal(state.isDimmed(item(2, ["a"], false)), true);
});

// A user's own label literally named "flagged" must not act as the flag —
// the whole reason the focus target is a tagged union and not a string.
test("a label named 'flagged' is not the flag", () => {
  state.focus = { kind: "flagged" };
  assert.equal(state.isDimmed(item(1, ["flagged"], false)), true);
  state.focus = { kind: "labels", labels: ["flagged"] };
  assert.equal(state.isDimmed(item(2, ["flagged"], false)), false);
  assert.equal(state.isDimmed(item(3, [], true)), true);
});

test("flaggedCount counts children as well as top-level items", () => {
  state.current = roadmap([
    item(1, [], true, [item(2, [], true), item(3, [], false)]),
    item(4, [], false),
    item(5, [], true),
  ]);
  assert.equal(state.flaggedCount(), 3);

  state.current = roadmap([item(1, [], false)]);
  assert.equal(state.flaggedCount(), 0);

  state.current = null;
  assert.equal(state.flaggedCount(), 0);
});

test("isolating a lane hides the rest, and Show all brings them back", () => {
  const saved = (): number[] =>
    (JSON.parse(localStorage.getItem("roadie.hidden.1") ?? "null") as number[]).sort();
  state.current = roadmapOf([lane(1), lane(2), lane(3)]);
  state.hiddenLanes = new Set([1]);

  state.isolateLane(2);
  assert.deepEqual([...state.hiddenLanes].sort(), [1, 3]);
  assert.deepEqual(saved(), [1, 3]);
  // Isolating the already-isolated lane is a no-op, not a way back out.
  state.isolateLane(2);
  assert.deepEqual([...state.hiddenLanes].sort(), [1, 3]);
  // Isolating a hidden lane shows it.
  state.isolateLane(1);
  assert.deepEqual([...state.hiddenLanes].sort(), [2, 3]);

  state.showAllLanes();
  assert.equal(state.hiddenLanes.size, 0);
  assert.deepEqual(saved(), []);
});

test("bulk parent folding toggles every parent and deselects hidden children", () => {
  const saved = (): number[] =>
    (JSON.parse(localStorage.getItem("roadie.collapsed.1") ?? "null") as number[]).sort();
  const a = item(1, [], false, [item(2, [], false)]);
  const b = item(3, [], false, [item(4, [], false)]);
  state.current = roadmap([a, item(5, [], false), b]);
  state.collapsed = new Set([a.id]);
  state.selectedItemIds = new Set([2, 3, 4, 5]);

  assert.equal(state.hasParentItems(), true);
  assert.equal(state.allParentsCollapsed(), false);
  state.setAllParentsCollapsed(true);
  assert.deepEqual([...state.collapsed].sort(), [1, 3]);
  assert.deepEqual([...state.selectedItemIds].sort(), [3, 5]);
  assert.equal(state.allParentsCollapsed(), true);
  assert.deepEqual(saved(), [1, 3]);

  state.setAllParentsCollapsed(false);
  assert.equal(state.collapsed.size, 0);
  assert.equal(state.allParentsCollapsed(), false);
  assert.deepEqual(saved(), []);

  state.current = roadmap([item(6, [], false)]);
  assert.equal(state.hasParentItems(), false);
});
