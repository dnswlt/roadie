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
    children,
  };
}

function roadmap(items: ItemFull[]): RoadmapFull {
  const lane: LaneFull = {
    id: 1,
    roadmapId: 1,
    name: "L",
    position: 0,
    color: "blue",
    items,
    milestones: [],
  };
  return {
    id: 1,
    name: "R",
    createdAt: "2026-01-01T00:00:00Z",
    visibility: "public",
    lanes: [lane],
    periods: [],
    dependencies: [],
  };
}

test("no focus dims nothing", () => {
  state.focus = null;
  assert.equal(state.isDimmed(item(1, [], false)), false);
  assert.equal(state.isDimmed(item(2, ["a"], true)), false);
});

test("label focus dims items without that label", () => {
  state.focus = { kind: "label", label: "a" };
  assert.equal(state.isDimmed(item(1, ["a", "b"], false)), false);
  assert.equal(state.isDimmed(item(2, ["b"], false)), true);
  // A flagged item is not exempt: the two focus kinds are independent.
  assert.equal(state.isDimmed(item(3, [], true)), true);
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
  state.focus = { kind: "label", label: "flagged" };
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
