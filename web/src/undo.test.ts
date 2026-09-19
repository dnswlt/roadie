import { strict as assert } from "node:assert";
import { test } from "node:test";
import { describeEdit, editTarget, inverseOf, undoStack, type Edit } from "./undo";
import type { ItemFull, LaneFull, Milestone, RoadmapFull } from "./types";

function item(id: number, over: Partial<ItemFull> = {}): ItemFull {
  return {
    id,
    laneId: 1,
    parentId: null,
    title: `i${id}`,
    description: "",
    startDate: "2026-01-05",
    endDate: "2026-02-01",
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
    date: "2026-03-01",
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

// Ranks are array order in the model, and a child's lane is its parent's; the
// builders above leave both to the fixture, so fix them up where a test reads
// a position back.
function roadmap(lanes: LaneFull[]): RoadmapFull {
  for (const l of lanes) {
    l.items.forEach((it, i) => {
      it.rank = i;
      it.laneId = l.id;
      it.children.forEach((c, j) => {
        c.rank = j;
        c.parentId = it.id;
        c.laneId = l.id;
      });
    });
  }
  return {
    id: 1,
    uid: "uid-r1",
    name: "rm",
    createdAt: "2026-01-01T00:00:00Z",
    visibility: "public",
    lanes,
    periods: [],
    dependencies: [],
  };
}

test("a field patch inverts to the fields it sets, and to nothing else", () => {
  const rm = roadmap([lane(1, { items: [item(10, { title: "Alpha" })] })]);

  const inverse = inverseOf({ items: [{ id: 10, patch: { title: "Beta" } }] }, rm);

  assert.deepEqual(inverse, { items: [{ id: 10, patch: { title: "Alpha" } }] });
});

test("a date patch inverts to both dates only when both were set", () => {
  const rm = roadmap([lane(1, { items: [item(10)] })]);

  assert.deepEqual(
    inverseOf({ items: [{ id: 10, patch: { endDate: "2026-03-01" } }] }, rm)?.items,
    [{ id: 10, patch: { endDate: "2026-02-01" } }],
  );
  assert.deepEqual(
    inverseOf(
      { items: [{ id: 10, patch: { startDate: "2026-01-01", endDate: "2026-03-01" } }] },
      rm,
    )?.items,
    [{ id: 10, patch: { startDate: "2026-01-05", endDate: "2026-02-01" } }],
  );
});

// A move is one atom: the three structural fields travel together whichever of
// them the forward patch happened to set, because restoring any one of them
// alone would leave the item in a container or a slot it never occupied.
test("a rank change inverts to parent, lane and the item's current index", () => {
  const rm = roadmap([lane(1, { items: [item(10), item(11), item(12)] })]);

  const inverse = inverseOf({ items: [{ id: 12, patch: { rank: 0 } }] }, rm);

  assert.deepEqual(inverse?.items, [
    { id: 12, patch: { parentId: null, laneId: 1, rank: 2 } },
  ]);
});

test("a cross-context move inverts to the context and slot it left", () => {
  const rm = roadmap([
    lane(1, { items: [item(10), item(11)] }),
    lane(2, { items: [item(20)] }),
  ]);

  const inverse = inverseOf({ items: [{ id: 11, patch: { laneId: 2, rank: 0 } }] }, rm);

  assert.deepEqual(inverse?.items, [
    { id: 11, patch: { parentId: null, laneId: 1, rank: 1 } },
  ]);
});

test("a nested item's index is counted among its siblings", () => {
  const rm = roadmap([
    lane(1, { items: [item(10, { children: [item(100), item(101)] })] }),
  ]);

  const inverse = inverseOf({ items: [{ id: 101, patch: { parentId: null } }] }, rm);

  assert.deepEqual(inverse?.items, [
    { id: 101, patch: { parentId: 10, laneId: 1, rank: 1 } },
  ]);
});

// A parent dragged across contexts takes its children's dates with it, which
// is several patches in one batch — and one undo step.
test("a batch inverts entry by entry, in order", () => {
  const rm = roadmap([
    lane(1, { items: [item(10, { children: [item(100), item(101)] })] }),
    lane(2),
  ]);

  const inverse = inverseOf(
    {
      items: [
        { id: 10, patch: { laneId: 2, startDate: "2026-02-05" } },
        { id: 100, patch: { startDate: "2026-02-05" } },
        { id: 101, patch: { startDate: "2026-02-05" } },
      ],
    },
    rm,
  );

  assert.deepEqual(inverse?.items, [
    {
      id: 10,
      patch: { startDate: "2026-01-05", parentId: null, laneId: 1, rank: 0 },
    },
    { id: 100, patch: { startDate: "2026-01-05" } },
    { id: 101, patch: { startDate: "2026-01-05" } },
  ]);
});

// Labels are the one mutable value in a patch: an inverse holding the live
// array would be rewritten by the next edit to it.
test("labels are copied, not shared with the model", () => {
  const items = [item(10, { labels: ["api"] })];
  const rm = roadmap([lane(1, { items })]);

  const inverse = inverseOf({ items: [{ id: 10, patch: { labels: ["api", "ui"] } }] }, rm);
  items[0]!.labels.push("ui");

  assert.deepEqual(inverse?.items?.[0]?.patch.labels, ["api"]);
});

test("a milestone's integration value is read from its linkage", () => {
  const rm = roadmap([
    lane(1, {
      milestones: [
        milestone(50, 1, { linkage: { integration: true } }),
        milestone(51, 1),
      ],
    }),
  ]);

  const edit: Edit = {
    milestones: [
      { id: 50, patch: { integration: false } },
      { id: 51, patch: { integration: true } },
    ],
  };

  assert.deepEqual(inverseOf(edit, rm)?.milestones, [
    { id: 50, patch: { integration: true } },
    { id: 51, patch: { integration: false } },
  ]);
});

test("a milestone's lane move inverts to the lane it left", () => {
  const rm = roadmap([lane(1, { milestones: [milestone(50, 1)] }), lane(2)]);

  assert.deepEqual(
    inverseOf({ milestones: [{ id: 50, patch: { laneId: 2, date: "2026-04-01" } }] }, rm)
      ?.milestones,
    [{ id: 50, patch: { date: "2026-03-01", laneId: 1 } }],
  );
});

test("a context patch inverts to its current name and color", () => {
  const rm = roadmap([lane(1, { name: "Platform", color: "blue" })]);

  assert.deepEqual(inverseOf({ lanes: [{ id: 1, patch: { color: "amber" } }] }, rm)?.lanes, [
    { id: 1, patch: { color: "blue" } },
  ]);
});

test("a context reorder inverts to the order on screen", () => {
  const rm = roadmap([lane(1), lane(2), lane(3)]);

  assert.deepEqual(inverseOf({ laneOrder: [3, 1, 2] }, rm)?.laneOrder, [1, 2, 3]);
});

// Where the inverse cannot be read in full, there is no partial answer to give:
// undoing half a gesture is the case the stack exists to prevent.
test("an entity the roadmap no longer holds yields no inverse", () => {
  const rm = roadmap([lane(1, { items: [item(10)] })]);

  assert.equal(inverseOf({ items: [{ id: 99, patch: { title: "x" } }] }, rm), null);
  assert.equal(
    inverseOf(
      {
        items: [
          { id: 10, patch: { title: "x" } },
          { id: 99, patch: { title: "y" } },
        ],
      },
      rm,
    ),
    null,
  );
  assert.equal(inverseOf({ milestones: [{ id: 99, patch: { flagged: true } }] }, rm), null);
  assert.equal(inverseOf({ lanes: [{ id: 99, patch: { name: "x" } }] }, rm), null);
});

test("the label names the gesture and the entity it touched", () => {
  const rm = roadmap([
    lane(1, {
      name: "Platform",
      items: [item(10, { title: "Alpha" }), item(11, { title: "Beta" })],
      milestones: [milestone(50, 1, { title: "GA" })],
    }),
  ]);

  const label = (edit: Edit): string => describeEdit(edit, rm);
  assert.equal(label({ items: [{ id: 10, patch: { rank: 1 } }] }), 'move of "Alpha"');
  assert.equal(
    label({ items: [{ id: 10, patch: { startDate: "2026-02-05" } }] }),
    'date change of "Alpha"',
  );
  assert.equal(label({ items: [{ id: 10, patch: { title: "A" } }] }), 'title change of "Alpha"');
  assert.equal(label({ milestones: [{ id: 50, patch: { date: "2026-04-01" } }] }), 'date change of "GA"');
  assert.equal(label({ lanes: [{ id: 1, patch: { name: "Core" } }] }), 'rename of "Platform"');
  assert.equal(label({ laneOrder: [1] }), "context reorder");
  assert.equal(
    label({
      items: [
        { id: 10, patch: { startDate: "2026-02-05" } },
        { id: 11, patch: { startDate: "2026-02-05" } },
      ],
    }),
    "date change of 2 items",
  );
});

// A parent dragged with its children is one move, not one per patch: only the
// entries carrying the gesture's own fields are counted.
test("a move with following children is named after the item that moved", () => {
  const rm = roadmap([
    lane(1, { items: [item(10, { title: "Alpha", children: [item(100), item(101)] })] }),
  ]);

  const label = describeEdit(
    {
      items: [
        { id: 10, patch: { laneId: 2, startDate: "2026-02-05" } },
        { id: 100, patch: { startDate: "2026-02-05" } },
        { id: 101, patch: { startDate: "2026-02-05" } },
      ],
    },
    rm,
  );

  assert.equal(label, 'move of "Alpha"');
});

test("the replay target is the first entity the batch names", () => {
  assert.deepEqual(editTarget({ items: [{ id: 10, patch: {} }] }), { kind: "item", id: 10 });
  assert.deepEqual(editTarget({ milestones: [{ id: 50, patch: {} }] }), {
    kind: "milestone",
    id: 50,
  });
  assert.equal(editTarget({ lanes: [{ id: 1, patch: {} }] }), null);
  assert.equal(editTarget({ laneOrder: [1, 2] }), null);
});

// The stack is shared module state, so each test starts from a cleared one.
function step(n: number): { forward: Edit; inverse: Edit } {
  return {
    forward: { items: [{ id: n, patch: { title: `f${n}` } }] },
    inverse: { items: [{ id: n, patch: { title: `b${n}` } }] },
  };
}

test("the cursor walks back through the steps and forward again", () => {
  undoStack.clear();
  undoStack.push(step(1));
  undoStack.push(step(2));

  assert.deepEqual(undoStack.undoStep(), step(2));
  undoStack.commitUndo(undoStack.mark());
  assert.deepEqual(undoStack.undoStep(), step(1));
  assert.deepEqual(undoStack.redoStep(), step(2));
  undoStack.commitUndo(undoStack.mark());
  assert.equal(undoStack.undoStep(), null);
  assert.deepEqual(undoStack.redoStep(), step(1));
});

test("a new edit truncates the redo tail", () => {
  undoStack.clear();
  undoStack.push(step(1));
  undoStack.push(step(2));
  undoStack.commitUndo(undoStack.mark());

  undoStack.push(step(3));

  assert.equal(undoStack.redoStep(), null);
  assert.deepEqual(undoStack.undoStep(), step(3));
  undoStack.commitUndo(undoStack.mark());
  assert.deepEqual(undoStack.undoStep(), step(1));
});

// The invariant the whole design rests on: a replay walks the history it
// started from, or none at all. An edit recorded while it flew is one way that
// history moves; a clear is the other.
test("an edit recorded during a replay drops the history", () => {
  undoStack.clear();
  undoStack.push(step(1));
  const replaying = undoStack.mark();
  undoStack.push(step(2)); // an edit made while the undo flew

  undoStack.commitUndo(replaying);

  assert.equal(undoStack.undoStep(), null);
  assert.equal(undoStack.redoStep(), null);
});

test("a clear during a replay drops the history", () => {
  undoStack.clear();
  undoStack.push(step(1));
  const replaying = undoStack.mark();
  undoStack.clear();
  undoStack.push(step(2));

  undoStack.commitUndo(replaying);

  assert.equal(undoStack.undoStep(), null);
  assert.equal(undoStack.redoStep(), null);
});

test("the stack keeps its last entries and drops the oldest", () => {
  undoStack.clear();
  for (let i = 0; i < 60; i++) undoStack.push(step(i));

  for (let i = 59; i >= 10; i--) {
    assert.deepEqual(undoStack.undoStep(), step(i));
    undoStack.commitUndo(undoStack.mark());
  }
  assert.equal(undoStack.undoStep(), null);
});
