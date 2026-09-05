import { strict as assert } from "node:assert";
import { test } from "node:test";
import { state } from "./state";
import type { ItemFull, LaneFull, Milestone, RoadmapFull } from "./types";

// Minimal fixtures: scalar filters read labels/signals; dependency conflicts
// additionally read the dates below. Every other field gets a throwaway value.
function item(
  id: number,
  labels: string[],
  flagged: boolean,
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
    rank: 0,
    priority: null,
    labels,
    flagged,
    tentative: false,
    atRisk,
    children,
  };
}

function milestone(id: number, laneId = 1, over: Partial<Milestone> = {}): Milestone {
  return {
    id,
    uid: `uid-m${id}`,
    laneId,
    title: `m${id}`,
    description: "",
    date: "2026-01-02",
    tentative: false,
    atRisk: false,
    labels: [],
    flagged: false,
    ...over,
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
    uid: "uid-r1",
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

test("no filter matches every entity", () => {
  state.filter = null;
  assert.equal(state.matchesItem(item(1, [], false)), true);
  assert.equal(state.matchesItem(item(2, ["a"], true)), true);
  assert.equal(state.matchesMilestone(milestone(3)), true);
});

test("label filter matches items and milestones carrying that label", () => {
  state.filter = { kind: "labels", labels: ["a"] };
  assert.equal(state.matchesItem(item(1, ["a", "b"], false)), true);
  assert.equal(state.matchesItem(item(2, ["b"], false)), false);
  // A flagged item is not exempt: the two filter kinds are independent.
  assert.equal(state.matchesItem(item(3, [], true)), false);
  assert.equal(state.matchesMilestone(milestone(4, 1, { labels: ["a"] })), true);
  assert.equal(state.matchesMilestone(milestone(5)), false);
});

test("label vocabulary is shared by items, children and milestones", () => {
  const parent = item(1, ["parent"], false, [item(2, ["child"], false)]);
  const only = lane(1, [parent]);
  only.milestones.push(milestone(3, only.id, { labels: ["milestone", "parent"] }));
  state.current = roadmapOf([only]);

  assert.deepEqual(state.allLabels(), ["child", "milestone", "parent"]);
});

// Several picked labels match as OR: adding one widens the filter result.
test("multi-label filter excludes items carrying none of the labels", () => {
  state.filter = { kind: "labels", labels: ["a", "b"] };
  assert.equal(state.matchesItem(item(1, ["a"], false)), true);
  assert.equal(state.matchesItem(item(2, ["b", "c"], false)), true);
  assert.equal(state.matchesItem(item(3, ["c"], false)), false);
  assert.equal(state.matchesItem(item(4, [], false)), false);
});

test("toggling labels builds and empties the filter", () => {
  state.filter = null;
  state.toggleFilterLabel("a");
  assert.deepEqual(state.filter, { kind: "labels", labels: ["a"] });
  state.toggleFilterLabel("b");
  assert.deepEqual(state.filter, { kind: "labels", labels: ["a", "b"] });
  assert.equal(state.isFilterLabel("b"), true);

  // Alt-click narrows to one label, never back out — "Show all" does that.
  state.isolateFilterLabel("b");
  assert.deepEqual(state.filter, { kind: "labels", labels: ["b"] });
  state.isolateFilterLabel("b");
  assert.deepEqual(state.filter, { kind: "labels", labels: ["b"] });

  // Un-picking the last label is the same state as no filter at all.
  state.toggleFilterLabel("b");
  assert.equal(state.filter, null);
  assert.equal(state.isFilterLabel("b"), false);
});

test("inversion follows label and signal selections, and clears with the last selection", () => {
  state.resetFilter();
  state.toggleFilterInversion();
  assert.equal(state.filter, null, "no selection cannot be inverted");

  state.toggleFilterLabel("a");
  const candidate = item(1, ["a"], false);
  assert.equal(state.matchesItem(candidate), true);
  state.toggleFilterInversion();
  assert.equal(state.matchesItem(candidate), false, "inversion invalidates the projection");
  state.toggleFilterLabel("b");
  assert.deepEqual(state.filter, { kind: "labels", labels: ["a", "b"], inverted: true });
  state.isolateFilterLabel("b");
  assert.deepEqual(state.filter, { kind: "labels", labels: ["b"], inverted: true });

  state.toggleFilterSignal("flagged");
  assert.deepEqual(state.filter, { kind: "flagged", inverted: true });
  state.toggleFilterSignal("atRisk");
  assert.deepEqual(state.filter, { kind: "atRisk", inverted: true });
  state.toggleFilterLabel("b");
  assert.deepEqual(state.filter, { kind: "labels", labels: ["b"], inverted: true });

  state.toggleFilterInversion();
  assert.deepEqual(state.filter, { kind: "labels", labels: ["b"] });
  state.toggleFilterInversion();
  state.toggleFilterLabel("b");
  assert.equal(state.filter, null);
  state.toggleFilterSignal("flagged");
  assert.deepEqual(state.filter, { kind: "flagged" }, "clearing resets inversion");
  state.toggleFilterInversion();
  state.toggleFilterSignal("flagged");
  assert.equal(state.filter, null, "toggling the selected inverted signal clears it");
});

// Labels and the flag are one exclusive field, so picking either drops the other.
test("picking a label replaces a flag filter", () => {
  state.filter = { kind: "flagged" };
  state.toggleFilterLabel("a");
  assert.deepEqual(state.filter, { kind: "labels", labels: ["a"] });
});

test("flag filter excludes unflagged items regardless of labels", () => {
  state.filter = { kind: "flagged" };
  assert.equal(state.matchesItem(item(1, [], true)), true);
  assert.equal(state.matchesItem(item(2, ["a"], false)), false);
  assert.equal(state.matchesMilestone(milestone(3, 1, { flagged: true })), true);
  assert.equal(state.matchesMilestone(milestone(4)), false);
});

// A user's own label literally named "flagged" must not act as the flag —
// the whole reason the filter target is a tagged union and not a string.
test("a label named 'flagged' is not the flag", () => {
  state.filter = { kind: "flagged" };
  assert.equal(state.matchesItem(item(1, ["flagged"], false)), false);
  state.filter = { kind: "labels", labels: ["flagged"] };
  assert.equal(state.matchesItem(item(2, ["flagged"], false)), true);
  assert.equal(state.matchesItem(item(3, [], true)), false);
});

test("at-risk filter excludes items that are not at risk, flagged or not", () => {
  state.filter = { kind: "atRisk" };
  assert.equal(state.matchesItem(item(1, [], false, [], true)), true);
  assert.equal(state.matchesItem(item(2, ["a"], false, [], false)), false);
  // The two signals are independent: a flagged item is not spared, and an
  // at-risk one is included even when it lacks the flag.
  assert.equal(state.matchesItem(item(3, [], true, [], false)), false);
  assert.equal(state.matchesItem(item(4, [], true, [], true)), true);
  assert.equal(state.matchesMilestone(milestone(5, 1, { atRisk: true })), true);
  assert.equal(state.matchesMilestone(milestone(6)), false);
});

test("signal counts include milestones", () => {
  const only = lane(1, [item(1, [], true), item(2, [], false, [], true)]);
  only.milestones.push(
    milestone(3, only.id, { flagged: true, atRisk: true }),
    milestone(4, only.id),
  );
  state.current = roadmapOf([only]);

  assert.equal(state.flaggedCount(), 2);
  assert.equal(state.atRiskCount(), 2);
});

// The filter holds labels or one signal, never a mix, so each pick drops the other.
test("signal filters toggle exclusively and labels replace them", () => {
  state.filter = null;
  state.toggleFilterSignal("flagged");
  assert.deepEqual(state.filter, { kind: "flagged" });
  state.toggleFilterSignal("atRisk");
  assert.deepEqual(state.filter, { kind: "atRisk" });
  state.toggleFilterSignal("atRisk");
  assert.equal(state.filter, null);

  state.filter = { kind: "dependencyConflicts" };
  state.toggleFilterLabel("a");
  assert.deepEqual(state.filter, { kind: "labels", labels: ["a"] });
});

test("the recent filter is session-only, singular, and discarded when stale", () => {
  const tagged = item(1, ["keep"], true);
  state.current = roadmap([tagged]);
  state.filter = { kind: "labels", labels: ["keep"] };
  state.toggleRecentFilter();
  assert.equal(state.filter, null);
  state.toggleRecentFilter();
  assert.deepEqual(state.filter, { kind: "labels", labels: ["keep"] });

  state.filter = { kind: "flagged" };
  state.toggleRecentFilter();
  state.toggleRecentFilter();
  assert.deepEqual(state.filter, { kind: "flagged" }, "the latest filter wins globally");

  state.toggleRecentFilter();
  tagged.flagged = false;
  state.toggleRecentFilter();
  assert.equal(state.filter, null, "a filter with no live matches is rejected");
  tagged.flagged = true;
  state.toggleRecentFilter();
  assert.equal(state.filter, null, "a rejected filter is forgotten, not merely skipped");
});

test("the recent filter remembers inversion and evaluates the negated matches", () => {
  const untouched = item(1, [], false);
  const refined = item(2, ["refined"], false);
  state.current = roadmap([untouched, refined]);
  const filter = { kind: "labels", labels: ["refined"], inverted: true } as const;
  state.filter = filter;
  state.toggleRecentFilter();
  assert.equal(state.filter, null);
  state.toggleRecentFilter();
  assert.deepEqual(state.filter, filter, "a filter that divides the roadmap is restored");

  state.toggleRecentFilter();
  refined.labels = [];
  state.toggleRecentFilter();
  assert.equal(state.filter, null, "nothing excluded makes an inverted filter stale");

  untouched.labels = ["refined"];
  refined.labels = ["refined"];
  state.filter = filter;
  state.toggleRecentFilter();
  state.toggleRecentFilter();
  assert.equal(state.filter, null, "a negated filter that would hide everything is discarded too");

  state.filter = filter;
  state.resetFilter();
  untouched.labels = ["refined"];
  state.toggleRecentFilter();
  assert.equal(state.filter, null, "leaving the roadmap forgets inversion with the filter");
});

// resetFilter is selectRoadmap's leaving-this-roadmap call. A label filter
// names a string scoped to one roadmap, so it must not resurface just because
// an unrelated roadmap happens to reuse that label name.
test("switching roadmaps forgets the recent filter, even by label-name coincidence", () => {
  const here = item(1, ["urgent"], false);
  state.current = roadmap([here]);
  state.filter = { kind: "labels", labels: ["urgent"] };

  state.resetFilter();
  const elsewhere = item(2, ["urgent"], false); // same label name, different roadmap
  state.current = roadmap([elsewhere]);

  assert.equal(state.filter, null);
  state.toggleRecentFilter();
  assert.equal(state.filter, null, "no memory survived the switch to reapply");
});

test("dependency-conflict filter derives item and milestone endpoints and refreshes with dates", () => {
  const prerequisite = item(1, [], false);
  prerequisite.endDate = "2026-02-01";
  const dependent = item(2, [], false);
  const unrelated = item(3, [], false);
  state.current = roadmap([prerequisite, dependent, unrelated]);
  const conflictedMilestone = milestone(10);
  state.current.lanes[0]!.milestones.push(conflictedMilestone);
  state.current.dependencies = [
    {
      id: 1,
      from: { kind: "item", id: prerequisite.id },
      to: { kind: "item", id: dependent.id },
    },
    {
      id: 2,
      from: { kind: "item", id: prerequisite.id },
      to: { kind: "milestone", id: conflictedMilestone.id },
    },
  ];

  assert.equal(state.dependencyConflictCount(), 3);
  state.toggleFilterSignal("dependencyConflicts");
  assert.equal(state.matchesItem(prerequisite), true);
  assert.equal(state.matchesItem(dependent), true);
  assert.equal(state.matchesMilestone(conflictedMilestone), true);
  assert.equal(state.matchesItem(unrelated), false);

  prerequisite.endDate = dependent.endDate;
  state.notify();
  assert.equal(state.dependencyConflictCount(), 0);
  assert.equal(state.matchesItem(prerequisite), false);
  assert.equal(state.matchesMilestone(conflictedMilestone), false);
  state.filter = null;
});

test("jumpTo clears filter for a non-matching item, including a retained parent", () => {
  const parent = item(1, [], false, [item(2, ["keep"], false)]);
  state.current = roadmap([parent]);
  state.filter = { kind: "labels", labels: ["keep"] };

  assert.equal(state.matchesItem(parent), false, "the parent is only a hierarchy breadcrumb");
  assert.equal(state.jumpTo("item", parent.id), true);
  assert.equal(state.filter, null);
  assert.equal(state.selectedItemId, parent.id);
});

test("jumpTo preserves filter for a direct match", () => {
  const matching = item(1, ["keep"], false);
  state.current = roadmap([matching]);
  state.filter = { kind: "labels", labels: ["keep"] };

  assert.equal(state.jumpTo("item", matching.id), true);
  assert.deepEqual(state.filter, { kind: "labels", labels: ["keep"] });
  assert.equal(state.selectedItemId, matching.id);
});

test("jumpTo clears a filter that excludes a milestone", () => {
  const only = lane(1);
  const ms = milestone(10);
  only.milestones.push(ms);
  state.current = roadmapOf([only]);
  state.filter = { kind: "labels", labels: ["keep"] };

  assert.equal(state.matchesMilestone(ms), false);
  assert.equal(state.jumpTo("milestone", ms.id), true);
  assert.equal(state.filter, null);
  assert.equal(state.selectedMilestoneId, ms.id);
});

test("an active filter forces every parent open without losing the saved fold", () => {
  const parent = item(1, [], false, [item(2, ["keep"], false)]);
  state.current = roadmap([parent]);
  state.filter = null;
  state.setCollapsed(parent.id, true);
  assert.equal(state.rendersCollapsed(parent.id), true);

  state.filter = { kind: "labels", labels: ["keep"] };
  assert.equal(state.rendersCollapsed(parent.id), false);
  assert.equal(state.isCollapsed(parent.id), true, "the preference survives the filter");

  state.filter = null;
  assert.equal(state.rendersCollapsed(parent.id), true);
  state.setCollapsed(parent.id, false);
});

test("a full render drops selections the filter removes but keeps a retained parent", () => {
  const parent = item(1, [], false, [item(2, ["keep"], false)]);
  const removed = item(3, [], false);
  const matching = item(4, ["keep"], false);
  state.current = roadmap([parent, removed, matching]);
  state.selectedItemIds = new Set([parent.id, removed.id, matching.id]);
  state.filter = { kind: "labels", labels: ["keep"] };

  state.notify();

  assert.deepEqual([...state.selectedItemIds].sort(), [parent.id, matching.id]);
});

test("a full render drops a selected item that stops matching the active filter", () => {
  const selected = item(1, [], true);
  state.current = roadmap([selected]);
  state.selectedItemIds = new Set([selected.id]);
  state.filter = { kind: "flagged" };

  selected.flagged = false;
  state.notify();

  assert.equal(state.selectedItemId, null);
});

test("a full render drops a milestone excluded by the active filter", () => {
  const only = lane(1, [item(1, ["keep"], false)]);
  const ms = milestone(10);
  only.milestones.push(ms);
  state.current = roadmapOf([only]);
  state.selectedMilestoneId = ms.id;
  state.filter = { kind: "labels", labels: ["keep"] };

  state.notify();

  assert.equal(state.selectedMilestoneId, null);
  assert.deepEqual([...state.projection().drawnMilestoneIds], []);
});

test("hiding contexts drops their item and milestone selections", () => {
  const first = lane(1, [item(1, [], false)]);
  first.milestones.push({
    id: 10,
    uid: "uid-m10",
    laneId: first.id,
    title: "M",
    description: "",
    date: "2026-01-01",
    tentative: false,
    atRisk: false,
    labels: [],
    flagged: false,
  });
  const second = lane(2, [item(2, [], false)]);
  state.current = roadmapOf([first, second]);
  state.filter = null;
  state.selectedItemIds = new Set([1, 2]);

  state.setLaneHidden(first.id, true);
  assert.deepEqual([...state.selectedItemIds], [2]);

  state.selectedMilestoneId = 10;
  state.isolateLane(second.id);
  assert.equal(state.selectedMilestoneId, null);

  state.hiddenLanes = new Set();
  state.selectedItemIds = new Set();
});

test("folding a WBS milestone group drops its selected milestone locally", () => {
  const only = lane(1);
  only.milestones.push({
    id: 10,
    uid: "uid-m10",
    laneId: only.id,
    title: "M",
    description: "",
    date: "2026-01-01",
    tentative: false,
    atRisk: false,
    labels: [],
    flagged: false,
  });
  state.current = roadmapOf([only]);
  state.hiddenLanes = new Set();
  state.selectedMilestoneId = 10;

  state.setMilestonesCollapsed(only.id, true);

  assert.equal(state.selectedMilestoneId, null);
  state.wbsMsCollapsed = new Set();
});

// Selections and view preferences are pruned against the ids that are on
// screen, so what survives a reload is decided entirely by whether those ids
// came back. A restore keeps them, which is why a shareable link, a selection
// and a hidden lane all still point at what they did before it.
test("selection and hidden lanes survive a restore, and only ids decide it", () => {
  const ms = (id: number, laneId: number) => ({
    id,
    uid: `uid-m${id}`,
    laneId,
    title: "M",
    description: "",
    date: "2026-01-01",
    tentative: false,
    atRisk: false,
    labels: [],
    flagged: false,
  });
  const laneWith = (id: number, itemId: number, msId: number): LaneFull => {
    const l = lane(id, [item(itemId, [], false)]);
    l.milestones.push(ms(msId, id));
    return l;
  };

  state.current = roadmapOf([laneWith(1, 1, 10), lane(2)]);
  state.filter = null;
  state.setLaneHidden(2, true);
  state.selectedItemIds = new Set([1]);
  state.selectedMilestoneId = 10;

  // What the client does after a restore: refetch, reload the preferences,
  // re-render. The payload carries the same ids, so nothing is pruned.
  state.current = roadmapOf([laneWith(1, 1, 10), lane(2)]);
  state.loadHiddenLanes();
  state.notify();
  assert.deepEqual([...state.selectedItemIds], [1]);
  assert.equal(state.selectedMilestoneId, 10);
  assert.equal(state.isLaneHidden(2), true);

  // The same content under fresh ids is a different set of entities, and
  // everything that pointed at the old ones is dropped — which is exactly what
  // a renumbering restore would have done to them.
  state.current = roadmapOf([laneWith(3, 4, 11), lane(5)]);
  state.loadHiddenLanes();
  state.notify();
  assert.deepEqual([...state.selectedItemIds], []);
  assert.equal(state.selectedMilestoneId, null);
  assert.equal(state.isLaneHidden(2), false);

  state.hiddenLanes = new Set();
  state.selectedItemIds = new Set();
  state.selectedMilestoneId = null;
});

test("atRiskCount counts children as well as top-level items", () => {
  state.current = roadmap([
    item(1, [], false, [item(2, [], false, [], true), item(3, [], true)], true),
    item(4, [], true),
  ]);
  assert.equal(state.atRiskCount(), 2);
  // Counted independently of the flag, which sits on different items here.
  assert.equal(state.flaggedCount(), 2);

  state.current = null;
  assert.equal(state.atRiskCount(), 0);
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

// "v" from the reconciliation view returns to the chart view last shown. The
// case that catches a stale lastChartMode is the one boot produces: app.ts
// restores a persisted WBS by assigning navigation.view directly, so nothing but
// setViewMode can have recorded which chart view is behind Recon.
test("v returns to the chart view boot restored, not the default", () => {
  state.navigation.view = "wbs"; // exactly what boot does for a persisted WBS
  state.setViewMode("recon");
  state.toggleChartView();
  assert.equal(state.navigation.view, "wbs");
});

test("v alternates the chart views, and never lands on recon", () => {
  state.setViewMode("timeline");
  state.toggleChartView();
  assert.equal(state.navigation.view, "wbs");
  state.toggleChartView();
  assert.equal(state.navigation.view, "timeline");

  // Entered from the timeline, "v" comes back to it.
  state.setViewMode("recon");
  state.toggleChartView();
  assert.equal(state.navigation.view, "timeline");
});

test("leaving Recon preserves its selected tab", () => {
  state.navigation.tabs.recon = "schedule";
  state.setViewMode("recon");
  state.setViewMode("wbs");
  state.setViewMode("recon");

  assert.equal(state.navigation.tabs.recon, "schedule");
});
