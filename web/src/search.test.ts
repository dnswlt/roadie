import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseQuery, search } from "./search";
import type { ItemFull, LaneFull, Milestone, RoadmapFull } from "./types";

// Minimal fixtures: search reads titles, labels, descriptions, dates and the
// lane name, so everything else gets a throwaway value.
interface ItemSpec {
  id: number;
  title: string;
  description?: string;
  labels?: string[];
  start?: string;
  children?: ItemSpec[];
}

function item(spec: ItemSpec): ItemFull {
  return {
    id: spec.id,
    laneId: 1,
    parentId: null,
    title: spec.title,
    description: spec.description ?? "",
    startDate: spec.start ?? "2026-01-01",
    endDate: "2026-12-31",
    rank: 0,
    priority: null,
    labels: spec.labels ?? [],
    flagged: false,
    tentative: false,
    atRisk: false,
    children: (spec.children ?? []).map(item),
  };
}

function lane(id: number, name: string, items: ItemSpec[], milestones: Milestone[] = []): LaneFull {
  return {
    id,
    roadmapId: 1,
    name,
    position: id,
    color: "blue",
    items: items.map(item),
    milestones,
  };
}

function roadmap(...lanes: LaneFull[]): RoadmapFull {
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

const titles = (rm: RoadmapFull, q: string): string[] => search(rm, q).map((m) => m.title);

test("parseQuery lowercases and drops empty terms", () => {
  assert.deepEqual(parseQuery("  Auth   MIGR "), ["auth", "migr"]);
  assert.deepEqual(parseQuery("   "), []);
});

test("an empty query matches nothing", () => {
  const rm = roadmap(lane(1, "Platform", [{ id: 1, title: "Anything" }]));
  assert.deepEqual(search(rm, ""), []);
  assert.deepEqual(search(rm, "   "), []);
});

test("terms are ANDed and order-independent", () => {
  const rm = roadmap(
    lane(1, "Platform", [
      { id: 1, title: "Migrate auth provider" },
      { id: 2, title: "Migrate billing" },
      { id: 3, title: "Auth cleanup" },
    ]),
  );
  assert.deepEqual(titles(rm, "auth migr"), ["Migrate auth provider"]);
  assert.deepEqual(titles(rm, "migr auth"), ["Migrate auth provider"]);
  // Reversed and spelled out in full — a literal-substring match of the raw
  // input finds nothing here, which is the reason for splitting into terms.
  assert.deepEqual(titles(rm, "auth migrate"), ["Migrate auth provider"]);
  // AND, not OR: each term matches something, but no single row has both.
  assert.deepEqual(titles(rm, "auth billing"), []);
});

test("matching is case-insensitive", () => {
  const rm = roadmap(lane(1, "Platform", [{ id: 1, title: "Migrate AUTH provider" }]));
  assert.deepEqual(titles(rm, "AuTh"), ["Migrate AUTH provider"]);
});

test("ranking: title prefix, then word start, then mid-word", () => {
  const rm = roadmap(
    lane(1, "Platform", [
      { id: 1, title: "Reauthorize tokens" }, // mid-word
      { id: 2, title: "Rotate auth keys" }, // word start
      { id: 3, title: "Auth provider swap" }, // prefix
    ]),
  );
  assert.deepEqual(titles(rm, "auth"), [
    "Auth provider swap",
    "Rotate auth keys",
    "Reauthorize tokens",
  ]);
});

test("a later word-start hit outranks a buried earlier one", () => {
  const rm = roadmap(
    lane(1, "Platform", [
      { id: 1, title: "Reauthorize auth flow" }, // buried first, word start later
      { id: 2, title: "Deauthorize sessions" }, // buried only
    ]),
  );
  assert.deepEqual(titles(rm, "auth"), ["Reauthorize auth flow", "Deauthorize sessions"]);
});

test("title beats label beats description beats context", () => {
  const rm = roadmap(
    lane(1, "Kafka", [
      { id: 1, title: "Consumer group audit" }, // matches via the lane name only
      { id: 2, title: "Broker upgrade", description: "replaces kafka 2.8" },
      { id: 3, title: "Retention policy", labels: ["kafka"] },
      { id: 4, title: "Kafka rebalance" },
    ]),
  );
  assert.deepEqual(titles(rm, "kafka"), [
    "Kafka rebalance",
    "Retention policy",
    "Broker upgrade",
    "Consumer group audit",
  ]);
  const fields = search(rm, "kafka").map((m) => m.field);
  assert.deepEqual(fields, ["title", "label", "description", "context"]);
});

test("a row ranks by its weakest term", () => {
  const rm = roadmap(
    lane(1, "Platform", [
      // Both terms in the title.
      { id: 1, title: "Auth token rotation" },
      // One in the title, one only in the description — must rank below.
      { id: 2, title: "Auth cleanup", description: "covers token expiry" },
    ]),
  );
  assert.deepEqual(titles(rm, "auth token"), ["Auth token rotation", "Auth cleanup"]);
});

test("the lane name is searchable, so a context term narrows a query", () => {
  const rm = roadmap(
    lane(1, "Platform", [{ id: 1, title: "Auth rewrite" }]),
    lane(2, "Payments", [{ id: 2, title: "Auth rewrite" }]),
  );
  const hits = search(rm, "platform auth");
  assert.deepEqual(
    hits.map((m) => m.laneName),
    ["Platform"],
  );
});

test("children of collapsed parents are searched too", () => {
  const rm = roadmap(
    lane(1, "Platform", [{ id: 1, title: "Parent", children: [{ id: 2, title: "Buried child" }] }]),
  );
  const hits = search(rm, "buried");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, 2);
  assert.equal(hits[0]!.kind, "item");
});

test("milestones match on title and description and carry their date twice", () => {
  const ms: Milestone = {
    id: 7,
    uid: "uid-m7",
    laneId: 1,
    title: "GA launch",
    description: "auth complete",
    date: "2026-06-01",
    tentative: false,
  };
  const rm = roadmap(lane(1, "Platform", [], [ms]));
  const byTitle = search(rm, "GA");
  assert.equal(byTitle.length, 1);
  assert.equal(byTitle[0]!.kind, "milestone");
  assert.equal(byTitle[0]!.startDate, "2026-06-01");
  assert.equal(byTitle[0]!.endDate, "2026-06-01");
  assert.equal(search(rm, "auth")[0]!.field, "description");
});

test("ties break by start date, then title", () => {
  const rm = roadmap(
    lane(1, "Platform", [
      { id: 1, title: "Auth c", start: "2026-03-01" },
      { id: 2, title: "Auth b", start: "2026-01-01" },
      { id: 3, title: "Auth a", start: "2026-03-01" },
    ]),
  );
  assert.deepEqual(titles(rm, "auth"), ["Auth b", "Auth a", "Auth c"]);
});

test("search returns every match, not a page", () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, title: `Widget ${i}` }));
  const rm = roadmap(lane(1, "Platform", many));
  assert.equal(search(rm, "widget").length, 120);
});
