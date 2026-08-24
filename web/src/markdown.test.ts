import { strict as assert } from "node:assert";
import { test } from "node:test";
import { itemMarkdown, laneMarkdown, roadmapMarkdown } from "./markdown";
import type { ItemFull, LaneFull, Milestone, RoadmapFull } from "./types";

function item(over: Partial<ItemFull> = {}): ItemFull {
  return {
    id: 1,
    laneId: 1,
    parentId: null,
    title: "Item",
    description: "",
    startDate: "2027-04-05",
    endDate: "2027-04-09",
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

function lane(over: Partial<LaneFull> = {}): LaneFull {
  return {
    id: 1,
    roadmapId: 1,
    name: "Contize",
    position: 0,
    color: "blue",
    items: [],
    milestones: [],
    ...over,
  };
}

function roadmap(over: Partial<RoadmapFull> = {}): RoadmapFull {
  return {
    id: 1,
    uid: "uid-r1",
    name: "Platform 2027",
    createdAt: "2026-01-01T00:00:00Z",
    visibility: "public",
    lanes: [],
    periods: [],
    dependencies: [],
    ...over,
  };
}

const milestone = (over: Partial<Milestone> = {}): Milestone => ({
  id: 1,
  uid: "uid-m1",
  laneId: 1,
  title: "Beta",
  description: "",
  date: "2027-06-01",
  tentative: false,
  ...over,
});

test("an item is a bare title heading with its metadata on the next line", () => {
  const md = itemMarkdown(roadmap(), lane(), item(), null);
  const lines = md.split("\n");
  const head = lines.indexOf("### Item");
  assert.ok(head > 0, "title should be a heading of its own");
  // Directly beneath, no blank line: the metadata belongs to the heading, and
  // CommonMark allows a paragraph to follow an ATX heading immediately.
  assert.equal(lines[head + 1], "*2027-04-05 → 2027-04-09 · 5 days*");
});

test("a single-day item says 1 day, not 0", () => {
  // The reason durations are printed at all: inclusive dates make the naive
  // subtraction wrong, and a reader cannot tell which convention is in play.
  const md = itemMarkdown(roadmap(), lane(), item({ endDate: "2027-04-05" }), null);
  assert.match(md, /· 1 day\*/);
});

test("priority, flag and labels only appear when set", () => {
  const plain = itemMarkdown(roadmap(), lane(), item(), null);
  assert.doesNotMatch(plain, /P\d|⚑/);

  const full = itemMarkdown(
    roadmap(),
    lane(),
    item({ priority: 1, flagged: true, labels: ["infra", "q2"] }),
    null,
  );
  assert.match(full, /· P1 · ⚑ · infra, q2\*$/m);
});

test("tentative timing prefixes the date range with ≈; committed dates carry none", () => {
  const md = itemMarkdown(roadmap(), lane(), item({ tentative: true }), null);
  assert.match(md, /^\*≈ 2027-04-05 → 2027-04-09 · 5 days\*$/m);
  assert.doesNotMatch(itemMarkdown(roadmap(), lane(), item(), null), /≈/);
});

test("at risk is ⚠ beside the flag's ⚑, and both can be present at once", () => {
  const md = itemMarkdown(roadmap(), lane(), item({ atRisk: true, flagged: true }), null);
  assert.match(md, /· ⚠ · ⚑\*$/m);
  assert.doesNotMatch(itemMarkdown(roadmap(), lane(), item(), null), /⚠/);
});

test("a copied item keeps the heading levels of the full export", () => {
  const top = itemMarkdown(roadmap(), lane(), item(), null);
  assert.match(top, /^## Contize$/m);
  assert.match(top, /^### Item$/m);

  const parent = item({ title: "Parent", startDate: "2027-01-01", endDate: "2027-12-31" });
  const child = itemMarkdown(roadmap(), lane(), item({ title: "Sub" }), parent);
  assert.match(child, /^## Contize$/m);
  assert.match(child, /^### Parent$/m);
  assert.match(child, /^#### Sub$/m);
  // The parent is context, not content: its heading is bare, so its dates —
  // which were not what was copied — must not appear.
  assert.doesNotMatch(child, /2027-01-01/);
});

test("a child sits one heading level below its parent", () => {
  const parent = item({ title: "Parent", children: [item({ id: 2, title: "Child" })] });
  const md = itemMarkdown(roadmap(), lane(), parent, null);
  assert.match(md, /^### Parent$/m);
  assert.match(md, /^#### Child$/m);
});

test("milestones are one bulleted section, title and date on one line", () => {
  const md = laneMarkdown(
    roadmap(),
    lane({ milestones: [milestone(), milestone({ id: 2, title: "GA", date: "2027-09-01" })] }),
  );
  assert.match(md, /^### Milestones$/m);
  assert.match(md, /^- \*\*Beta\*\* — 2027-06-01$/m);
  assert.match(md, /^- \*\*GA\*\* — 2027-09-01$/m);
});

test("a tentative milestone prefixes its exported date with ≈", () => {
  const md = laneMarkdown(roadmap(), lane({ milestones: [milestone({ tentative: true })] }));
  assert.match(md, /^- \*\*Beta\*\* — ≈ 2027-06-01$/m);
});

test("a milestone description is indented under its bullet", () => {
  const md = laneMarkdown(
    roadmap(),
    lane({ milestones: [milestone({ description: "Hard regulatory date." })] }),
  );
  assert.match(md, /^ {2}Hard regulatory date\.$/m);
});

test("no Milestones section when a lane has none", () => {
  const md = laneMarkdown(roadmap(), lane({ items: [item()] }));
  assert.doesNotMatch(md, /Milestones/);
});

// The reason for headings: a description is reproduced exactly as written, at
// column 0, so nothing whitespace-sensitive in it can be altered by where it
// sits. Indenting it into a list item is what this format exists to avoid.
test("a description is reproduced verbatim at column 0", () => {
  const desc = "First line\n\n- a bullet the author wrote\n\n```\ncode()\n```";
  const md = itemMarkdown(roadmap(), lane(), item({ description: desc }), null);
  assert.ok(md.includes(desc), "description should appear untouched");
});

test("a lane renders its milestones before its items", () => {
  const l = lane({ items: [item({ title: "Work" })], milestones: [milestone()] });
  const md = laneMarkdown(roadmap(), l);
  assert.ok(md.indexOf("### Milestones") < md.indexOf("### Work"), "milestones should come first");
});

test("an empty lane says so rather than rendering a bare heading", () => {
  assert.match(laneMarkdown(roadmap(), lane()), /_No items\._/);
});

test("the whole roadmap includes every lane, and the schedule when there is one", () => {
  const rm = roadmap({
    lanes: [lane({ name: "A", items: [item()] }), lane({ id: 2, name: "B" })],
    periods: [{ id: 1, label: "Sprint 1", startDate: "2027-01-04", endDate: "2027-01-15" }],
  });
  const md = roadmapMarkdown(rm);
  assert.match(md, /^# Platform 2027$/m);
  assert.match(md, /^\*\*Schedule\*\*$/m);
  assert.match(md, /^- Sprint 1 — 2027-01-04 → 2027-01-15$/m);
  assert.match(md, /^## A$/m);
  assert.match(md, /^## B$/m);
});

test("no schedule section when the roadmap has no periods", () => {
  assert.doesNotMatch(roadmapMarkdown(roadmap({ lanes: [lane()] })), /Schedule/);
});

test("a lane and a roadmap say when they were copied; an item does not", () => {
  // Built from local parts and formatted from local parts, so the expected
  // string holds in any timezone.
  const at = new Date(2026, 6, 15, 13, 45);
  assert.match(roadmapMarkdown(roadmap({ lanes: [lane()] }), at), /^Copied 2026-07-15 13:45$/m);
  assert.match(laneMarkdown(roadmap(), lane(), at), /^Copied 2026-07-15 13:45$/m);
  assert.doesNotMatch(itemMarkdown(roadmap(), lane(), item(), null), /Copied/);
});

test("the copy time is zero-padded to a fixed shape", () => {
  const at = new Date(2026, 0, 5, 9, 7);
  assert.match(laneMarkdown(roadmap(), lane(), at), /^Copied 2026-01-05 09:07$/m);
});

test("every scope names the roadmap it came from", () => {
  for (const md of [
    roadmapMarkdown(roadmap({ lanes: [lane()] })),
    laneMarkdown(roadmap(), lane()),
    itemMarkdown(roadmap(), lane(), item(), null),
  ]) {
    assert.match(md, /^# Platform 2027$/m);
  }
});

// A heading needs a blank line before it to be a heading at all in some
// renderers, and the spacing must not depend on whether an entry happens to
// have a description.
test("every heading is preceded by a blank line, described or not", () => {
  const l = lane({
    milestones: [milestone()],
    items: [
      item({ id: 1, title: "Plain" }),
      item({ id: 2, title: "Described", description: "why" }),
      item({ id: 3, title: "Last", children: [item({ id: 4, title: "Kid" })] }),
    ],
  });
  const lines = laneMarkdown(roadmap(), l).split("\n");
  const heads = lines.map((l, i) => (l.startsWith("#") ? i : -1)).filter((i) => i > 0);
  assert.equal(heads.length, 6, "lane, milestone, three items, one child — the roadmap title is index 0");
  for (const i of heads) {
    assert.equal(lines[i - 1], "", `line ${i} (${lines[i]}) should be preceded by a blank`);
  }
});

test("a described entry does not gain a second blank line", () => {
  const md = laneMarkdown(roadmap(), lane({ items: [item({ description: "why" }), item({ id: 2 })] }));
  assert.doesNotMatch(md, /\n\n\n/);
});

test("output has no trailing blank lines", () => {
  const md = roadmapMarkdown(roadmap({ lanes: [lane({ items: [item()] })] }));
  assert.equal(md, md.trimEnd());
});
