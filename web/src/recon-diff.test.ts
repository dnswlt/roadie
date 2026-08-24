import assert from "node:assert/strict";
import { test } from "node:test";

import { diffTrackerIssues, roadieItemsWithoutJiraReference } from "./recon-diff";
import type { Item, ItemFull, LaneFull, RoadmapFull, TrackerIssue } from "./types";

function child(id: number, title: string, description = ""): Item {
  return {
    id,
    laneId: 1,
    parentId: 1,
    title,
    description,
    startDate: "2026-01-01",
    endDate: "2026-01-02",
    rank: 0,
    priority: null,
    labels: [],
    flagged: false,
    tentative: false,
    atRisk: false,
  };
}

function item(id: number, title: string, description = "", children: Item[] = []): ItemFull {
  return { ...child(id, title, description), parentId: null, children };
}

function roadmap(...items: ItemFull[]): RoadmapFull {
  const lane: LaneFull = {
    id: 1,
    roadmapId: 1,
    name: "Delivery",
    position: 0,
    color: "green",
    items,
    // A milestone link must never count as an item reference.
    milestones: [
      {
        id: 99,
        uid: "uid-m99",
        laneId: 1,
        title: "Launch",
        description: "https://jira.example.test/jira/browse/PAY-3",
        date: "2026-02-01",
        tentative: false,
      },
    ],
  };
  return {
    id: 1,
    uid: "uid-r1",
    name: "Roadmap",
    createdAt: "2026-01-01T00:00:00Z",
    visibility: "public",
    lanes: [lane],
    periods: [],
    dependencies: [],
  };
}

function issue(key: string): TrackerIssue {
  return {
    id: key,
    key,
    title: key,
    type: "Epic",
    status: "To Do",
    url: `https://jira.example.test/jira/browse/${key}`,
  };
}

test("diff matches top-level items and children, but not milestones", () => {
  const rm = roadmap(
    item(1, "Payments", "See https://jira.example.test/jira/browse/pay-1?tab=work#comment", [
      child(2, "Checkout", "[Jira](https://jira.example.test/jira/browse/PAY-2)"),
    ]),
  );

  const rows = diffTrackerIssues([issue("PAY-1"), issue("PAY-2"), issue("PAY-3")], rm);
  assert.deepEqual(
    rows.map((row) => row.matches.map((match) => match.title)),
    [["Payments"], ["Checkout"], []],
  );
  assert.equal(rows[0]!.matches[0]!.laneColor, "green");
});

test("diff requires the configured Jira origin and context path", () => {
  const rm = roadmap(
    item(1, "Wrong host", "https://other.test/jira/browse/PAY-1"),
    item(2, "Wrong Jira", "https://jira.example.test/other/browse/PAY-1"),
    item(3, "Wrong scheme", "http://jira.example.test/jira/browse/PAY-1"),
  );
  assert.deepEqual(diffTrackerIssues([issue("PAY-1")], rm)[0]!.matches, []);
});

test("diff is many-to-many and de-duplicates references within one item", () => {
  const rm = roadmap(
    item(
      1,
      "Shared delivery",
      [
        "https://jira.example.test/jira/browse/PAY-1",
        "https://jira.example.test/jira/browse/pay-1?focusedCommentId=7",
        "https://jira.example.test/jira/browse/PAY-2",
      ].join(" "),
    ),
    item(2, "Second owner", "https://jira.example.test/jira/browse/PAY-1"),
  );

  const rows = diffTrackerIssues([issue("PAY-1"), issue("PAY-2")], rm);
  assert.deepEqual(rows[0]!.matches.map((match) => match.title), ["Shared delivery", "Second owner"]);
  assert.deepEqual(rows[1]!.matches.map((match) => match.title), ["Shared delivery"]);
});

test("diff leaves malformed canonical tracker issues unmatched", () => {
  const malformed = { ...issue("PAY-1"), url: "https://jira.example.test/issues/PAY-1" };
  const wrongKey = { ...issue("PAY-1"), url: "https://jira.example.test/jira/browse/PAY-2" };
  const rm = roadmap(item(1, "Payments", "https://jira.example.test/jira/browse/PAY-1"));
  assert.deepEqual(
    diffTrackerIssues([malformed, wrongKey], rm).map((row) => row.matches),
    [[], []],
  );
});

test("diff handles no roadmap without changing issue order", () => {
  const issues = [issue("PAY-2"), issue("PAY-1")];
  const rows = diffTrackerIssues(issues, null);
  assert.deepEqual(rows.map((row) => row.issue.key), ["PAY-2", "PAY-1"]);
  assert.ok(rows.every((row) => row.matches.length === 0));
});

test("unreferenced Roadie items are flat, individually checked, and keep roadmap order", () => {
  const rm = roadmap(
    item(1, "Linked parent", "https://jira.example.test/jira/browse/PAY-1", [
      child(2, "Unlinked child"),
      child(3, "Linked child", "[work](https://jira.example.test/jira/browse/pay-2?tab=work)"),
    ]),
    item(4, "Unlinked parent", "A normal link: https://example.test/document"),
  );
  rm.lanes.push({
    id: 2,
    roadmapId: 1,
    name: "Operations",
    position: 1,
    color: "blue",
    items: [{ ...item(5, "Later lane"), laneId: 2 }],
    milestones: [],
  });

  assert.deepEqual(roadieItemsWithoutJiraReference(rm), [
    {
      itemId: 2,
      title: "Unlinked child",
      laneName: "Delivery",
      laneColor: "green",
      parentTitle: "Linked parent",
    },
    {
      itemId: 4,
      title: "Unlinked parent",
      laneName: "Delivery",
      laneColor: "green",
      parentTitle: null,
    },
    {
      itemId: 5,
      title: "Later lane",
      laneName: "Operations",
      laneColor: "blue",
      parentTitle: null,
    },
  ]);
});

test("unreferenced Roadie items reject malformed Jira-shaped links and ignore milestones", () => {
  const rm = roadmap(
    item(1, "Zero key", "https://jira.example.test/browse/PAY-0"),
    item(2, "Not browse", "https://jira.example.test/issues/PAY-2"),
  );
  assert.deepEqual(
    roadieItemsWithoutJiraReference(rm).map((row) => row.title),
    ["Zero key", "Not browse"],
  );
  assert.deepEqual(roadieItemsWithoutJiraReference(null), []);
});
