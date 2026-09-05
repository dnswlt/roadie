import { strict as assert } from "node:assert";
import { test } from "node:test";
import { diffCounts, diffRoadmaps, isEmptyDiff, type RoadmapDiff } from "./diff";
import type {
  Dependency,
  ItemFull,
  LaneFull,
  Milestone,
  RoadmapFull,
  SchedulePeriod,
} from "./types";

let nextId = 1000;

function item(id: number, laneId: number, over: Partial<ItemFull> = {}): ItemFull {
  return {
    id,
    laneId,
    parentId: null,
    title: `i${id}`,
    description: "",
    startDate: "2026-01-01",
    endDate: "2026-01-10",
    rank: 0,
    priority: null,
    labels: [],
    flagged: false,
    tentative: false,
    atRisk: false,
    children: [],
    ...over,
  };
}

function milestone(id: number, laneId: number, over: Partial<Milestone> = {}): Milestone {
  return {
    id,
    uid: `uid-m${id}`,
    laneId,
    title: `m${id}`,
    description: "",
    date: "2026-02-01",
    tentative: false,
    atRisk: false,
    labels: [],
    flagged: false,
    ...over,
  };
}

function lane(id: number, over: Partial<LaneFull> = {}): LaneFull {
  return {
    id,
    roadmapId: 1,
    name: `lane${id}`,
    position: 0,
    color: "blue",
    items: [],
    milestones: [],
    ...over,
  };
}

function roadmap(lanes: LaneFull[], over: Partial<RoadmapFull> = {}): RoadmapFull {
  return {
    id: 1,
    uid: "uid-r1",
    name: "rm",
    createdAt: "2026-01-01T00:00:00Z",
    visibility: "public",
    lanes,
    periods: [],
    dependencies: [],
    ...over,
  };
}

// Ranks and positions are array order in the model; the builders above ignore
// them, so re-rank a lane's arrays where a test cares about order.
function ranked(l: LaneFull): LaneFull {
  l.items.forEach((it, i) => {
    it.rank = i;
    it.children.forEach((c, j) => {
      c.rank = j;
      c.parentId = it.id;
    });
  });
  return l;
}

function dep(id: number, fromId: number, toId: number): Dependency {
  return { id, from: { kind: "item", id: fromId }, to: { kind: "item", id: toId } };
}

function period(label: string, startDate: string, endDate: string): SchedulePeriod {
  return { id: nextId++, label, startDate, endDate };
}

// The one-line invariant the whole module hangs on: identical contents (ids
// included) diff to nothing.
test("identical roadmaps produce an empty diff", () => {
  const make = (): RoadmapFull =>
    roadmap([ranked(lane(1, { items: [item(10, 1, { children: [item(11, 1)] })] }))], {
      periods: [{ id: 5, label: "S1", startDate: "2026-01-01", endDate: "2026-01-14" }],
      dependencies: [dep(7, 10, 11)],
    });
  const d = diffRoadmaps(make(), make());
  assert.equal(isEmptyDiff(d), true);
  assert.deepEqual(diffCounts(d), { added: 0, removed: 0, modified: 0 });
});

// A restore reinserts the roadmap's entities under the database IDs the
// snapshot recorded, so diffing a snapshot against the roadmap it was just
// restored into has nothing to report. That is what makes version history
// legible: before this, a restore renumbered everything and the diff honestly
// read as replace-all — which is the second half of this test.
//
// Dependency rows do get fresh IDs across a restore. They are matched by
// endpoint pair, so that must not show up either.
test("a restored snapshot diffs to nothing against the snapshot", () => {
  const snapshot = roadmap(
    [
      ranked(
        lane(1, {
          items: [item(10, 1, { children: [item(11, 1)] })],
          milestones: [milestone(20, 1)],
        }),
      ),
    ],
    { dependencies: [dep(7, 10, 11)] },
  );
  const restored = roadmap(
    [
      ranked(
        lane(1, {
          items: [item(10, 1, { children: [item(11, 1)] })],
          milestones: [milestone(20, 1)],
        }),
      ),
    ],
    { dependencies: [dep(99, 10, 11)] },
  );
  assert.equal(isEmptyDiff(diffRoadmaps(snapshot, restored)), true);

  // The same content under fresh IDs is a different set of entities, and the
  // diff says so rather than pretending to recognize them by title.
  const renumbered = roadmap(
    [
      ranked(
        lane(2, {
          items: [item(30, 2, { children: [item(31, 2)] })],
          milestones: [milestone(40, 2)],
        }),
      ),
    ],
    { dependencies: [dep(99, 30, 31)] },
  );
  assert.deepEqual(diffCounts(diffRoadmaps(snapshot, renumbered)), {
    added: 3,
    removed: 3,
    modified: 0,
  });
});

test("a field edit is one modified entry naming its fields", () => {
  const before = roadmap([lane(1, { items: [item(10, 1)] })]);
  const after = roadmap([
    lane(1, { items: [item(10, 1, { title: "renamed", endDate: "2026-01-20", flagged: true })] }),
  ]);
  const d = diffRoadmaps(before, after);
  assert.equal(d.lanes.length, 1);
  const entry = d.lanes[0]!.items[0]!;
  assert.equal(entry.kind, "modified");
  assert.deepEqual(entry.fields, ["title", "dates", "flagged"]);
  assert.equal(entry.before!.title, "i10");
  assert.equal(entry.after!.title, "renamed");
});

test("added and removed items are classified and counted", () => {
  const before = roadmap([lane(1, { items: [item(10, 1), item(11, 1)] })]);
  const after = roadmap([lane(1, { items: [item(10, 1), item(12, 1)] })]);
  const d = diffRoadmaps(before, after);
  const kinds = d.lanes[0]!.items.map((e) => [e.kind, (e.after ?? e.before)!.id]);
  assert.deepEqual(kinds, [
    ["added", 12],
    ["removed", 11],
  ]);
  assert.deepEqual(diffCounts(d), { added: 1, removed: 1, modified: 0 });
});

test("an unchanged parent survives as a breadcrumb for its changed child", () => {
  const child = (): ItemFull => item(11, 1);
  const before = roadmap([ranked(lane(1, { items: [item(10, 1, { children: [child()] })] }))]);
  const afterChild = child();
  afterChild.description = "now different";
  const after = roadmap([ranked(lane(1, { items: [item(10, 1, { children: [afterChild] })] }))]);
  const d = diffRoadmaps(before, after);
  const parent = d.lanes[0]!.items[0]!;
  assert.equal(parent.kind, "unchanged");
  assert.equal(parent.children.length, 1);
  assert.equal(parent.children[0]!.kind, "modified");
  assert.deepEqual(parent.children[0]!.fields, ["description"]);
  assert.deepEqual(diffCounts(d), { added: 0, removed: 0, modified: 1 });
});

test("a removed child hangs under its surviving unchanged parent", () => {
  const before = roadmap([
    ranked(lane(1, { items: [item(10, 1, { children: [item(11, 1)] })] })),
  ]);
  const after = roadmap([ranked(lane(1, { items: [item(10, 1)] }))]);
  const d = diffRoadmaps(before, after);
  const parent = d.lanes[0]!.items[0]!;
  assert.equal(parent.kind, "unchanged");
  assert.deepEqual(
    parent.children.map((c) => c.kind),
    ["removed"],
  );
});

test("a lane move shows once, in the target lane, as a modified item", () => {
  const before = roadmap([lane(1, { items: [item(10, 1)] }), lane(2)]);
  const after = roadmap([lane(1), lane(2, { items: [item(10, 2)] })]);
  const d = diffRoadmaps(before, after);
  assert.equal(d.lanes.length, 1);
  assert.equal(d.lanes[0]!.after!.id, 2);
  const entry = d.lanes[0]!.items[0]!;
  assert.equal(entry.kind, "modified");
  assert.deepEqual(entry.fields, ["lane"]);
});

test("nesting an item is a parent change at its new position", () => {
  const before = roadmap([ranked(lane(1, { items: [item(10, 1), item(11, 1)] }))]);
  const after = roadmap([ranked(lane(1, { items: [item(10, 1, { children: [item(11, 1)] })] }))]);
  const d = diffRoadmaps(before, after);
  const parent = d.lanes[0]!.items[0]!;
  assert.equal(parent.kind, "unchanged"); // breadcrumb
  assert.equal(parent.children[0]!.kind, "modified");
  assert.deepEqual(parent.children[0]!.fields, ["parent"]);
});

test("a pure reorder is only the lane's orderChanged flag", () => {
  const before = roadmap([ranked(lane(1, { items: [item(10, 1), item(11, 1)] }))]);
  const after = roadmap([ranked(lane(1, { items: [item(11, 1), item(10, 1)] }))]);
  const d = diffRoadmaps(before, after);
  assert.equal(d.lanes.length, 1);
  assert.equal(d.lanes[0]!.orderChanged, true);
  assert.equal(d.lanes[0]!.items.length, 0);
  assert.deepEqual(diffCounts(d), { added: 0, removed: 0, modified: 0 });
});

test("labels compare as sets, so a reorder is no change", () => {
  const before = roadmap([lane(1, { items: [item(10, 1, { labels: ["a", "b"] })] })]);
  const after = roadmap([lane(1, { items: [item(10, 1, { labels: ["b", "a"] })] })]);
  assert.equal(isEmptyDiff(diffRoadmaps(before, after)), true);
});

test("a label swap is one labels change", () => {
  const before = roadmap([lane(1, { items: [item(10, 1, { labels: ["a", "b"] })] })]);
  const after = roadmap([lane(1, { items: [item(10, 1, { labels: ["b", "c"] })] })]);
  const entry = diffRoadmaps(before, after).lanes[0]!.items[0]!;
  assert.equal(entry.kind, "modified");
  assert.deepEqual(entry.fields, ["labels"]);
});

test("adding an item does not trip orderChanged", () => {
  const before = roadmap([ranked(lane(1, { items: [item(10, 1), item(11, 1)] }))]);
  const after = roadmap([ranked(lane(1, { items: [item(10, 1), item(12, 1), item(11, 1)] }))]);
  const d = diffRoadmaps(before, after);
  assert.equal(d.lanes[0]!.orderChanged, false);
});

test("lane rename and recolor mark the lane modified", () => {
  const before = roadmap([lane(1, { name: "Platform", color: "blue" })]);
  const after = roadmap([lane(1, { name: "Core", color: "green" })]);
  const d = diffRoadmaps(before, after);
  assert.equal(d.lanes[0]!.kind, "modified");
  assert.deepEqual(d.lanes[0]!.fields, ["name", "color"]);
});

test("lane add and remove carry their contents as added/removed rows", () => {
  const before = roadmap([lane(1, { items: [item(10, 1)], milestones: [milestone(50, 1)] })]);
  const after = roadmap([lane(2, { items: [item(20, 2)] })]);
  const d = diffRoadmaps(before, after);
  assert.deepEqual(
    d.lanes.map((l) => l.kind),
    ["added", "removed"],
  );
  assert.equal(d.lanes[0]!.items[0]!.kind, "added");
  assert.equal(d.lanes[1]!.items[0]!.kind, "removed");
  assert.equal(d.lanes[1]!.milestones[0]!.kind, "removed");
});

test("lane reorder is the roadmap-level flag only", () => {
  const before = roadmap([lane(1), lane(2)]);
  const after = roadmap([lane(2), lane(1)]);
  const d = diffRoadmaps(before, after);
  assert.equal(d.laneOrderChanged, true);
  assert.equal(d.lanes.length, 0);
});

test("milestone edits are classified like items", () => {
  const before = roadmap([lane(1, { milestones: [milestone(50, 1), milestone(51, 1)] })]);
  const after = roadmap([
    lane(1, { milestones: [milestone(50, 1, { date: "2026-03-01" }), milestone(52, 1)] }),
  ]);
  const d = diffRoadmaps(before, after);
  const kinds = d.lanes[0]!.milestones.map((m) => [m.kind, ...m.fields]);
  assert.deepEqual(kinds, [["modified", "date"], ["added"], ["removed"]]);
});

test("milestone metadata changes are visible modified fields", () => {
  const before = roadmap([lane(1, { milestones: [milestone(50, 1)] })]);
  const after = roadmap([
    lane(1, {
      milestones: [
        milestone(50, 1, {
          labels: ["release"],
          flagged: true,
          tentative: true,
          atRisk: true,
        }),
      ],
    }),
  ]);
  const d = diffRoadmaps(before, after);
  assert.equal(isEmptyDiff(d), false);
  assert.equal(d.lanes[0]!.milestones[0]!.kind, "modified");
  assert.deepEqual(d.lanes[0]!.milestones[0]!.fields, [
    "labels",
    "flagged",
    "tentative",
    "atRisk",
  ]);
  assert.deepEqual(diffCounts(d), { added: 0, removed: 0, modified: 1 });
});

test("publishing an integration milestone is a visible modified field", () => {
  const before = roadmap([lane(1, { milestones: [milestone(50, 1)] })]);
  const after = roadmap([
    lane(1, { milestones: [milestone(50, 1, { linkage: { integration: true } })] }),
  ]);
  const d = diffRoadmaps(before, after);
  assert.deepEqual(d.lanes[0]!.milestones[0]!.fields, ["integration"]);
});

test("mirror source resolution does not change the snapshot diff", () => {
  const cached = milestone(50, 1, {
    linkage: { integration: false, sourceUid: "uid-source" },
  });
  const resolved = milestone(50, 1, {
    date: "2026-04-01",
    tentative: true,
    atRisk: true,
    linkage: {
      integration: false,
      sourceUid: "uid-source",
      source: {
        roadmapId: 2,
        roadmapName: "Provider",
        milestoneId: 60,
        title: "Source milestone",
      },
    },
  });

  const d = diffRoadmaps(
    roadmap([lane(1, { milestones: [cached] })]),
    roadmap([lane(1, { milestones: [resolved] })]),
  );
  assert.equal(isEmptyDiff(d), true);
});

test("periods diff by value, so a relabel reads as removed plus added", () => {
  const before = roadmap([], { periods: [period("S1", "2026-01-01", "2026-01-14")] });
  const after = roadmap([], { periods: [period("Sprint 1", "2026-01-01", "2026-01-14")] });
  const d = diffRoadmaps(before, after);
  assert.deepEqual(
    d.periodsAdded.map((p) => p.label),
    ["Sprint 1"],
  );
  assert.deepEqual(
    d.periodsRemoved.map((p) => p.label),
    ["S1"],
  );
});

test("identical periods with fresh ids diff to nothing", () => {
  const before = roadmap([], { periods: [period("S1", "2026-01-01", "2026-01-14")] });
  const after = roadmap([], { periods: [period("S1", "2026-01-01", "2026-01-14")] });
  assert.equal(isEmptyDiff(diffRoadmaps(before, after)), true);
});

test("a dependency is identified by its endpoints, not its row id", () => {
  const items = (): ItemFull[] => [item(10, 1), item(11, 1), item(12, 1), item(13, 1)];
  const before = roadmap([ranked(lane(1, { items: items() }))], {
    dependencies: [dep(1, 10, 11), dep(2, 10, 12)],
  });
  const after = roadmap([ranked(lane(1, { items: items() }))], {
    dependencies: [dep(9, 10, 11), dep(8, 13, 12)],
  });
  const d = diffRoadmaps(before, after);
  assert.deepEqual(
    d.depsAdded.map((e) => `${e.from.id}>${e.to.id}`),
    ["13>12"],
  );
  assert.deepEqual(
    d.depsRemoved.map((e) => `${e.from.id}>${e.to.id}`),
    ["10>12"],
  );
});

test("reversing an edge is a removal plus an addition", () => {
  const items = (): ItemFull[] => [item(10, 1), item(11, 1)];
  const before = roadmap([ranked(lane(1, { items: items() }))], {
    dependencies: [dep(1, 10, 11)],
  });
  const after = roadmap([ranked(lane(1, { items: items() }))], {
    dependencies: [dep(1, 11, 10)],
  });
  const d = diffRoadmaps(before, after);
  assert.equal(d.depsAdded.length, 1);
  assert.equal(d.depsRemoved.length, 1);
});

// Edge changes attach to BOTH endpoints — an edge change genuinely changes
// both entities' situations — with `incoming` telling the two sides apart.
test("an edge change attaches to both endpoints, direction marked", () => {
  const items = (): ItemFull[] => [item(10, 1), item(11, 1)];
  const before = roadmap([ranked(lane(1, { items: items() }))]);
  const after = roadmap([ranked(lane(1, { items: items() }))], {
    dependencies: [dep(1, 10, 11)],
  });
  const d = diffRoadmaps(before, after);
  assert.equal(d.lanes.length, 1);
  assert.equal(d.lanes[0]!.items.length, 2);
  const byId = (id: number) => d.lanes[0]!.items.find((e) => (e.after ?? e.before)!.id === id)!;
  const from = byId(10);
  assert.equal(from.kind, "modified");
  assert.deepEqual(from.fields, ["deps"]);
  assert.deepEqual(from.depsAdded, [{ other: { kind: "item", id: 11 }, incoming: false }]);
  const to = byId(11);
  assert.equal(to.kind, "modified");
  assert.deepEqual(to.fields, ["deps"]);
  assert.deepEqual(to.depsAdded, [{ other: { kind: "item", id: 10 }, incoming: true }]);
});

test("a removed edge whose prerequisite was deleted still shows on the survivor", () => {
  const before = roadmap([ranked(lane(1, { items: [item(10, 1), item(11, 1)] }))], {
    dependencies: [dep(1, 10, 11)],
  });
  const after = roadmap([ranked(lane(1, { items: [item(11, 1)] }))]);
  const d = diffRoadmaps(before, after);
  const byId = (id: number) => d.lanes[0]!.items.find((e) => (e.after ?? e.before)!.id === id)!;
  const gone = byId(10);
  assert.equal(gone.kind, "removed");
  // The kind carries the story; no "deps" chip on top of "removed".
  assert.deepEqual(gone.fields, []);
  const survivor = byId(11);
  assert.equal(survivor.kind, "modified");
  assert.deepEqual(survivor.fields, ["deps"]);
  assert.deepEqual(survivor.depsRemoved, [{ other: { kind: "item", id: 10 }, incoming: true }]);
});

test("an added item that is a prerequisite stays just added", () => {
  const before = roadmap([ranked(lane(1, { items: [item(11, 1)] }))]);
  const after = roadmap([ranked(lane(1, { items: [item(10, 1), item(11, 1)] }))], {
    dependencies: [dep(1, 10, 11)],
  });
  const d = diffRoadmaps(before, after);
  const entry = d.lanes[0]!.items.find((e) => (e.after ?? e.before)!.id === 10)!;
  assert.equal(entry.kind, "added");
  assert.deepEqual(entry.fields, []);
});

test("a milestone endpoint carries its edge change too", () => {
  const ms = (): Milestone[] => [milestone(50, 1)];
  const items = (): ItemFull[] => [item(10, 1)];
  const before = roadmap([ranked(lane(1, { items: items(), milestones: ms() }))]);
  const after = roadmap([ranked(lane(1, { items: items(), milestones: ms() }))], {
    dependencies: [{ id: 1, from: { kind: "milestone", id: 50 }, to: { kind: "item", id: 10 } }],
  });
  const d = diffRoadmaps(before, after);
  const entry = d.lanes[0]!.milestones[0]!;
  assert.equal(entry.kind, "modified");
  assert.deepEqual(entry.fields, ["deps"]);
  assert.deepEqual(entry.depsAdded, [{ other: { kind: "item", id: 10 }, incoming: false }]);
  const dependent = d.lanes[0]!.items[0]!;
  assert.equal(dependent.kind, "modified");
  assert.deepEqual(dependent.depsAdded, [{ other: { kind: "milestone", id: 50 }, incoming: true }]);
});

// Placement rule: removed rows land in the lane they were in, after that
// lane's surviving changes.
test("a removed item in a surviving lane lands after that lane's other changes", () => {
  const before = roadmap([ranked(lane(1, { items: [item(10, 1), item(11, 1)] }))]);
  const after = roadmap([
    ranked(lane(1, { items: [item(10, 1, { title: "edited" })] })),
  ]);
  const d = diffRoadmaps(before, after);
  assert.deepEqual(
    d.lanes[0]!.items.map((e) => e.kind),
    ["modified", "removed"],
  );
});

function emptyLikeCheck(d: RoadmapDiff): void {
  assert.equal(isEmptyDiff(d), false);
}

test("order and schedule changes alone still make the diff non-empty", () => {
  emptyLikeCheck(
    diffRoadmaps(
      roadmap([ranked(lane(1, { items: [item(10, 1), item(11, 1)] }))]),
      roadmap([ranked(lane(1, { items: [item(11, 1), item(10, 1)] }))]),
    ),
  );
  emptyLikeCheck(
    diffRoadmaps(roadmap([]), roadmap([], { periods: [period("S1", "2026-01-01", "2026-01-14")] })),
  );
});
