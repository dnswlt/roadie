// Undo and redo for field edits. An undo adds no server concept: it is the same
// mutation path the edit took, called again with the inverse patch, so it takes
// its own snapshot, rings its own SSE doorbell, and is attributed to whoever
// pressed it.
//
// Everything here is DOM-free so undo.test.ts can pin it: the inverse of an
// Edit, the label a replay is announced with, and the stack itself.
//
// Creates and deletes stay out. Re-creating an entity issues a new database id,
// so its dependency edges, its children's parentage and every link to it would
// not come back — that is a restore, and version history does it.

import type {
  Item,
  ItemPatch,
  LaneFull,
  LanePatch,
  Milestone,
  MilestonePatch,
  RoadmapFull,
} from "./types";

// One user gesture as the batch of patches it already is: a title edit is one
// item patch, a parent drag is one structural patch plus a date patch per
// child, a context reorder is laneOrder. One Edit is one undo step.
export interface Edit {
  items?: { id: number; patch: ItemPatch }[];
  milestones?: { id: number; patch: MilestonePatch }[];
  lanes?: { id: number; patch: LanePatch }[];
  laneOrder?: number[];
}

// An item with its position in its container. rank == array index, so the
// index is the rank a restoring patch has to ask for.
interface PlacedItem {
  item: Item;
  index: number;
}

function placeItem(roadmap: RoadmapFull, id: number): PlacedItem | null {
  for (const lane of roadmap.lanes) {
    const index = lane.items.findIndex((i) => i.id === id);
    if (index >= 0) return { item: lane.items[index]!, index };
    for (const parent of lane.items) {
      const childIndex = parent.children.findIndex((c) => c.id === id);
      if (childIndex >= 0) return { item: parent.children[childIndex]!, index: childIndex };
    }
  }
  return null;
}

function findMilestone(roadmap: RoadmapFull, id: number): Milestone | null {
  for (const lane of roadmap.lanes) {
    const milestone = lane.milestones.find((m) => m.id === id);
    if (milestone) return milestone;
  }
  return null;
}

function findLane(roadmap: RoadmapFull, id: number): LaneFull | null {
  return roadmap.lanes.find((l) => l.id === id) ?? null;
}

// A patch touching any of parentId, laneId or rank inverts to all three, taking
// rank from the item's current index: a move is one atom. store.UpdateItem
// splices by remove-then-insert and keeps ranks dense, so restoring them
// restores the exact original order, siblings included.
function inverseItemPatch(patch: ItemPatch, placed: PlacedItem): ItemPatch {
  const { item } = placed;
  const inverse: ItemPatch = {};
  if (patch.title !== undefined) inverse.title = item.title;
  if (patch.description !== undefined) inverse.description = item.description;
  if (patch.startDate !== undefined) inverse.startDate = item.startDate;
  if (patch.endDate !== undefined) inverse.endDate = item.endDate;
  if (patch.priority !== undefined) inverse.priority = item.priority;
  if (patch.labels !== undefined) inverse.labels = [...item.labels];
  if (patch.flagged !== undefined) inverse.flagged = item.flagged;
  if (patch.tentative !== undefined) inverse.tentative = item.tentative;
  if (patch.atRisk !== undefined) inverse.atRisk = item.atRisk;
  if (patch.parentId !== undefined || patch.laneId !== undefined || patch.rank !== undefined) {
    inverse.parentId = item.parentId;
    inverse.laneId = item.laneId;
    inverse.rank = placed.index;
  }
  return inverse;
}

function inverseMilestonePatch(patch: MilestonePatch, milestone: Milestone): MilestonePatch {
  const inverse: MilestonePatch = {};
  if (patch.title !== undefined) inverse.title = milestone.title;
  if (patch.description !== undefined) inverse.description = milestone.description;
  if (patch.date !== undefined) inverse.date = milestone.date;
  if (patch.labels !== undefined) inverse.labels = [...milestone.labels];
  if (patch.flagged !== undefined) inverse.flagged = milestone.flagged;
  if (patch.tentative !== undefined) inverse.tentative = milestone.tentative;
  if (patch.atRisk !== undefined) inverse.atRisk = milestone.atRisk;
  // The milestone's integration value is a property of its linkage, which is
  // absent entirely when it has no cross-roadmap role.
  if (patch.integration !== undefined) {
    inverse.integration = milestone.linkage?.integration ?? false;
  }
  if (patch.laneId !== undefined) inverse.laneId = milestone.laneId;
  return inverse;
}

function inverseLanePatch(patch: LanePatch, lane: LaneFull): LanePatch {
  const inverse: LanePatch = {};
  if (patch.name !== undefined) inverse.name = lane.name;
  if (patch.color !== undefined) inverse.color = lane.color;
  return inverse;
}

// inverseOf reads an edit's inverse off `roadmap`, which must still be the
// state the edit is about to be applied to: it reads exactly the fields each
// patch sets, and copies the mutable ones.
//
// Null when the batch names an entity the roadmap no longer holds. A partial
// inverse would undo part of a gesture, so the caller drops the history rather
// than guess.
export function inverseOf(edit: Edit, roadmap: RoadmapFull): Edit | null {
  const inverse: Edit = {};
  if (edit.items) {
    const items: NonNullable<Edit["items"]> = [];
    for (const entry of edit.items) {
      const placed = placeItem(roadmap, entry.id);
      if (!placed) return null;
      items.push({ id: entry.id, patch: inverseItemPatch(entry.patch, placed) });
    }
    inverse.items = items;
  }
  if (edit.milestones) {
    const milestones: NonNullable<Edit["milestones"]> = [];
    for (const entry of edit.milestones) {
      const milestone = findMilestone(roadmap, entry.id);
      if (!milestone) return null;
      milestones.push({ id: entry.id, patch: inverseMilestonePatch(entry.patch, milestone) });
    }
    inverse.milestones = milestones;
  }
  if (edit.lanes) {
    const lanes: NonNullable<Edit["lanes"]> = [];
    for (const entry of edit.lanes) {
      const lane = findLane(roadmap, entry.id);
      if (!lane) return null;
      lanes.push({ id: entry.id, patch: inverseLanePatch(entry.patch, lane) });
    }
    inverse.lanes = lanes;
  }
  if (edit.laneOrder) inverse.laneOrder = roadmap.lanes.map((l) => l.id);
  return inverse;
}

type AnyPatch = ItemPatch | MilestonePatch | LanePatch;

// The patch types share no index signature, so reading a field by its name
// needs a cast. Naming a batch is the only place that does.
function sets(patch: AnyPatch, field: string): boolean {
  return (patch as Record<string, unknown>)[field] !== undefined;
}

// What a batch is called, decided by the fields it touches. The first match
// wins, and only the entries carrying that kind's fields are counted — so a
// parent dragged with three children is one move, not four.
const EDIT_KINDS: { kind: string; fields: string[] }[] = [
  { kind: "move", fields: ["parentId", "laneId", "rank"] },
  { kind: "date change", fields: ["startDate", "endDate", "date"] },
  { kind: "title change", fields: ["title"] },
  { kind: "rename", fields: ["name"] },
  { kind: "description change", fields: ["description"] },
  { kind: "label change", fields: ["labels"] },
  { kind: "color change", fields: ["color"] },
  { kind: "priority change", fields: ["priority"] },
  { kind: "flag change", fields: ["flagged"] },
  { kind: "integration change", fields: ["integration"] },
];

// describeEdit names the gesture for the toast, derived from the batch shape
// rather than passed in by the call site. Read after the replay has landed, so
// the name it prints is the one now on screen.
export function describeEdit(edit: Edit, roadmap: RoadmapFull): string {
  if (edit.laneOrder) return "context reorder";
  const entries: { patch: AnyPatch; name: string }[] = [];
  for (const entry of edit.items ?? []) {
    const placed = placeItem(roadmap, entry.id);
    if (placed) entries.push({ patch: entry.patch, name: placed.item.title });
  }
  for (const entry of edit.milestones ?? []) {
    const milestone = findMilestone(roadmap, entry.id);
    if (milestone) entries.push({ patch: entry.patch, name: milestone.title });
  }
  for (const entry of edit.lanes ?? []) {
    const lane = findLane(roadmap, entry.id);
    if (lane) entries.push({ patch: entry.patch, name: lane.name });
  }
  const match = EDIT_KINDS.find((k) => entries.some((e) => k.fields.some((f) => sets(e.patch, f))));
  const kind = match?.kind ?? "change";
  const named = match
    ? entries.filter((e) => match.fields.some((f) => sets(e.patch, f)))
    : entries;
  if (named.length === 1) return `${kind} of "${named[0]!.name}"`;
  if (named.length > 1) return `${kind} of ${named.length} items`;
  return kind;
}

// Where to take the user after a replay: the first entity the batch names. A
// lane patch or a reorder has none — nothing moved that has to be revealed.
export function editTarget(edit: Edit): { kind: "item" | "milestone"; id: number } | null {
  const item = edit.items?.[0];
  if (item) return { kind: "item", id: item.id };
  const milestone = edit.milestones?.[0];
  if (milestone) return { kind: "milestone", id: milestone.id };
  return null;
}

// One recorded gesture: the edit as made, and the inverse read before it was.
// An inverse is itself an Edit, which is what makes redo a cursor move.
export interface UndoStep {
  forward: Edit;
  inverse: Edit;
}

// Capped in memory and never persisted: after a reload there is no way to know
// what changed in between.
const MAX_STEPS = 50;

// The stack is a list plus a cursor: the steps before the cursor can be undone,
// the steps from it on redone. A new edit truncates the redo tail.
//
// Entries arrive in the order the client applied them, not the order the server
// answered in — see applyEdit. An edit that lands mid-replay is the one overlap
// left, and it leaves a cursor this list cannot describe, so the history is
// dropped instead (see mark). That is the same answer clearing gives
// everywhere else, and it keeps edits off a write queue.
class UndoStack {
  private steps: UndoStep[] = [];
  private cursor = 0;
  private generation = 0;

  // clear drops the history, which is how the stack's invariant is held rather
  // than checked: every entry belongs to the current live roadmap and to the
  // client state its inverse was read from. Called from state.ts (the model
  // replaced), events.ts (a remote edit seen, or the stream broken) and
  // actions.ts (a content mutation not recorded as an Edit).
  clear(): void {
    this.steps = [];
    this.cursor = 0;
    this.generation++;
  }

  // mark pins a replay to the history it started from. Every change to the
  // stack moves the mark on, so a replay whose mark has gone stale found the
  // history moved underneath it — a clear, or an edit recorded while it flew —
  // and drops it rather than step a cursor through an order it cannot know.
  mark(): number {
    return this.generation;
  }

  // moved reports a stale mark, dropping the history on the way out.
  private moved(mark: number): boolean {
    if (mark === this.generation) return false;
    this.clear();
    return true;
  }

  push(step: UndoStep): void {
    this.steps.length = this.cursor;
    this.steps.push(step);
    if (this.steps.length > MAX_STEPS) this.steps.shift();
    this.cursor = this.steps.length;
    this.generation++;
  }

  undoStep(): UndoStep | null {
    return this.cursor > 0 ? this.steps[this.cursor - 1]! : null;
  }

  redoStep(): UndoStep | null {
    return this.steps[this.cursor] ?? null;
  }

  commitUndo(mark: number): void {
    if (this.moved(mark)) return;
    this.cursor--;
    this.generation++;
  }

  commitRedo(mark: number): void {
    if (this.moved(mark)) return;
    this.cursor++;
    this.generation++;
  }
}

export const undoStack = new UndoStack();
