import { strict as assert } from "node:assert";
import { test } from "node:test";
import { analyzeDependencies, dateConflict, linkedRefs, refKey, sameRef, splitDeps } from "./deps-graph";
import type {
  Dependency,
  DependencyRef,
  Item,
  ItemFull,
  LaneFull,
  Milestone,
  RoadmapFull,
} from "./types";

const item = (id: number): DependencyRef => ({ kind: "item", id });
const ms = (id: number): DependencyRef => ({ kind: "milestone", id });

let nextId = 1;
const edge = (from: DependencyRef, to: DependencyRef): Dependency => ({ id: nextId++, from, to });

const baseItem = (id: number, laneId: number, rank: number): Item => ({
  id,
  laneId,
  parentId: null,
  title: `Item ${id}`,
  description: "",
  startDate: "2026-01-01",
  endDate: "2026-01-01",
  rank,
  priority: null,
  labels: [],
  flagged: false,
  tentative: false,
  atRisk: false,
});

const lane = (id: number, position: number, itemIds: number[], milestoneIds: number[] = []): LaneFull => ({
  id,
  roadmapId: 1,
  name: `Lane ${id}`,
  position,
  color: "blue",
  items: itemIds.map((itemId, rank): ItemFull => ({ ...baseItem(itemId, id, rank), children: [] })),
  milestones: milestoneIds.map(
    (milestoneId): Milestone => ({
      id: milestoneId,
      laneId: id,
      title: `Milestone ${milestoneId}`,
      description: "",
      date: "2026-01-01",
      tentative: false,
    }),
  ),
});

test("sameRef distinguishes kinds sharing an id", () => {
  assert.ok(sameRef(item(1), item(1)));
  assert.ok(!sameRef(item(1), ms(1)));
  assert.ok(!sameRef(item(1), item(2)));
});

test("refKey is kind-qualified", () => {
  assert.notEqual(refKey(item(1)), refKey(ms(1)));
});

test("splitDeps separates directions around one entity", () => {
  // a → b → M; c → b. Seen from b: depends on a and c, needed by M.
  const deps = [edge(item(1), item(2)), edge(item(2), ms(1)), edge(item(3), item(2))];
  const { dependsOn, neededBy } = splitDeps(deps, item(2));
  assert.deepEqual(
    dependsOn.map((d) => refKey(d.from)),
    ["item:1", "item:3"],
  );
  assert.deepEqual(
    neededBy.map((d) => refKey(d.to)),
    ["milestone:1"],
  );
  // An uninvolved entity sees nothing.
  const empty = splitDeps(deps, item(9));
  assert.equal(empty.dependsOn.length + empty.neededBy.length, 0);
});

test("splitDeps orders both sides by roadmap structure, not edge creation", () => {
  const lanes = [lane(1, 0, [10, 11], [20]), lane(2, 1, [12])];
  const center = item(99);
  const deps = [
    edge(item(12), center),
    edge(center, item(11)),
    edge(item(10), center),
    edge(center, ms(20)),
    edge(ms(20), center),
    edge(center, item(10)),
  ];

  const { dependsOn, neededBy } = splitDeps(deps, center, lanes);
  assert.deepEqual(
    dependsOn.map((d) => refKey(d.from)),
    ["milestone:20", "item:10", "item:12"],
  );
  assert.deepEqual(
    neededBy.map((d) => refKey(d.to)),
    ["milestone:20", "item:10", "item:11"],
  );
});

test("linkedRefs collects both directions", () => {
  const deps = [edge(item(1), item(2)), edge(item(2), ms(1))];
  assert.deepEqual([...linkedRefs(deps, item(2))].sort(), ["item:1", "milestone:1"]);
});

test("dateConflict compares finishes, strictly", () => {
  assert.ok(dateConflict("2026-02-01", "2026-01-15")); // prerequisite finishes last
  assert.ok(!dateConflict("2026-01-15", "2026-01-15")); // same-day finish is fine
  assert.ok(!dateConflict("2026-01-10", "2026-01-15"));
});

// analyzeDependencies needs real dates, which the lane() helper above fixes at one
// day; these build spans explicitly instead.
function datedItem(id: number, start: string, end: string): ItemFull {
  return { ...baseItem(id, 1, 0), startDate: start, endDate: end, children: [] };
}

function roadmap(items: ItemFull[], milestones: Milestone[], dependencies: Dependency[]): RoadmapFull {
  return {
    id: 1,
    name: "R",
    createdAt: "2026-01-01T00:00:00Z",
    visibility: "public",
    lanes: [{ id: 1, roadmapId: 1, name: "L", position: 0, color: "blue", items, milestones }],
    periods: [],
    dependencies,
  };
}

const milestone = (id: number, date: string): Milestone => ({
  id,
  laneId: 1,
  title: `M${id}`,
  description: "",
  date,
  tentative: false,
});

test("analyzeDependencies counts each direction and omits entities with no edges", () => {
  const rm = roadmap(
    [
      datedItem(1, "2026-01-01", "2026-01-31"),
      datedItem(2, "2026-02-01", "2026-02-28"),
      datedItem(3, "2026-03-01", "2026-03-31"), // untouched by any edge
    ],
    [],
    [edge(item(1), item(2))],
  );
  const s = analyzeDependencies(rm).summaries;
  assert.deepEqual(s.get("item:1"), { dependsOn: 0, neededBy: 1, conflicts: 0 });
  assert.deepEqual(s.get("item:2"), { dependsOn: 1, neededBy: 0, conflicts: 0 });
  // No entry at all, which is what tells the renderer to draw no mark.
  assert.equal(s.get("item:3"), undefined);
});

test("analyzeDependencies marks a date conflict on both ends of the edge", () => {
  // Item 1 runs into March but item 2, which needs it, is done in February.
  const rm = roadmap(
    [datedItem(1, "2026-01-01", "2026-03-31"), datedItem(2, "2026-02-01", "2026-02-28")],
    [],
    [edge(item(1), item(2))],
  );
  const s = analyzeDependencies(rm).summaries;
  assert.equal(s.get("item:1")?.conflicts, 1);
  assert.equal(s.get("item:2")?.conflicts, 1);
});

test("analyzeDependencies tolerates a dependent that starts before its prerequisite ends", () => {
  // Overlapping work is normal: item 2 starts mid-January, while item 1 runs to
  // the end of the month, but item 2 still finishes last.
  const rm = roadmap(
    [datedItem(1, "2026-01-01", "2026-01-31"), datedItem(2, "2026-01-15", "2026-02-28")],
    [],
    [edge(item(1), item(2))],
  );
  const s = analyzeDependencies(rm).summaries;
  assert.equal(s.get("item:1")?.conflicts, 0);
  assert.equal(s.get("item:2")?.conflicts, 0);
});

test("analyzeDependencies treats a milestone's date as both of its ends", () => {
  // The work finishes after the milestone it is supposed to enable.
  const late = roadmap(
    [datedItem(1, "2026-01-01", "2026-03-31")],
    [milestone(7, "2026-02-01")],
    [edge(item(1), ms(7))],
  );
  assert.equal(analyzeDependencies(late).summaries.get("milestone:7")?.conflicts, 1);

  // Landing exactly on the milestone's date is a handover, not a conflict.
  const onTime = roadmap(
    [datedItem(1, "2026-01-01", "2026-02-01")],
    [milestone(7, "2026-02-01")],
    [edge(item(1), ms(7))],
  );
  const s = analyzeDependencies(onTime).summaries;
  assert.equal(s.get("milestone:7")?.conflicts, 0);
  assert.equal(s.get("milestone:7")?.dependsOn, 1);
});

test("analyzeDependencies ignores an edge whose endpoint has vanished", () => {
  const rm = roadmap([datedItem(1, "2026-01-01", "2026-01-31")], [], [edge(item(1), item(99))]);
  const s = analyzeDependencies(rm).summaries;
  assert.equal(s.size, 0);
});

test("analyzeDependencies covers child items, which carry their own dates", () => {
  const parent: ItemFull = {
    ...baseItem(1, 1, 0),
    startDate: "2026-01-01",
    endDate: "2026-06-30",
    children: [{ ...baseItem(2, 1, 0), startDate: "2026-01-01", endDate: "2026-01-15" }],
  };
  const rm = roadmap([parent, datedItem(3, "2026-01-05", "2026-01-10")], [], [
    edge(item(2), item(3)),
  ]);
  const s = analyzeDependencies(rm).summaries;
  assert.equal(s.get("item:2")?.neededBy, 1);
  // The child's own dates decide it, not the parent's: the child ends Jan 15,
  // after the item 3 that needs it is already done on Jan 10.
  assert.equal(s.get("item:2")?.conflicts, 1);
});

test("analyzeDependencies reports the conflicting edge by id, for the overlay", () => {
  const bad = edge(item(1), item(2)); // 1 ends in March, 2 is done in February
  const good = edge(item(2), item(3)); // 2 ends in February, 3 in March
  const rm = roadmap(
    [
      datedItem(1, "2026-01-01", "2026-03-31"),
      datedItem(2, "2026-02-01", "2026-02-28"),
      datedItem(3, "2026-03-01", "2026-03-31"),
    ],
    [],
    [bad, good],
  );
  const { conflictingEdges } = analyzeDependencies(rm);
  assert.ok(conflictingEdges.has(bad.id));
  assert.ok(!conflictingEdges.has(good.id));
  assert.equal(conflictingEdges.size, 1);
});

test("analyzeDependencies spans every entity, edges or not, milestones as a point", () => {
  const rm = roadmap(
    [datedItem(1, "2026-01-01", "2026-01-31"), datedItem(2, "2026-02-01", "2026-02-28")],
    [milestone(7, "2026-05-01")],
    [], // no edges at all
  );
  const { spans, summaries } = analyzeDependencies(rm);
  // Spans are for display, so they cover entities the edge walk never touches.
  assert.equal(summaries.size, 0);
  assert.deepEqual(spans.get("item:1"), { start: "2026-01-01", end: "2026-01-31" });
  // Both ends equal is what makes a milestone card print one date, not a range.
  assert.deepEqual(spans.get("milestone:7"), { start: "2026-05-01", end: "2026-05-01" });
});
