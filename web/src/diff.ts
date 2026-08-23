// Pure version-diff computation between two RoadmapFull payloads, DOM-free so
// diff.test.ts can pin it; diff-view.ts renders the result. Computed on the
// client on purpose: both inputs are already served (GET /api/snapshots/{id}
// returns a normalized RoadmapFull, the live roadmap is in state), so a server
// endpoint would only add a second wire format to keep stable.
//
// Scope rule: the diff covers exactly what restoring the older version would
// change — lanes, items, milestones, periods, dependencies. Roadmap name,
// visibility and contributors are not restored, so they are not diffed.
//
// Identity is the database id (dependencies: the endpoint pair; periods: the
// whole value, see periodKey). A restore rewrites every id, so a diff that
// crosses a restore reports remove-everything/add-everything. Known and
// accepted for now rather than papered over with fuzzy matching.

import type {
  Dependency,
  DependencyRef,
  Item,
  Lane,
  LaneFull,
  Milestone,
  RoadmapFull,
  SchedulePeriod,
} from "./types";

export type ChangeKind = "added" | "removed" | "modified" | "unchanged";

// The fields a modified entity can differ in, at display granularity: the two
// date columns move together often enough that they are one "dates" change,
// lane/parent are the two kinds of move, and "deps" is a change to the edges
// this entity is the prerequisite of.
export type ItemField =
  | "title"
  | "description"
  | "dates"
  | "priority"
  | "labels"
  | "flagged"
  | "tentative"
  | "atRisk"
  | "lane"
  | "parent"
  | "deps";

export type MilestoneField = "title" | "description" | "date" | "lane" | "deps";

export type LaneField = "name" | "color";

// One end of a changed edge, as carried by an entity: `other` is the far
// endpoint, `incoming` says the edge points at this entity (it is the
// dependent) rather than away from it (it is the prerequisite). The renderer
// resolves `other` against the after side for added edges, before for removed.
export interface DepChange {
  other: DependencyRef;
  incoming: boolean;
}

// One item's change. `before`/`after` carry the full values — which fields
// changed is in `fields`, but what to show for them is the renderer's call.
// "unchanged" appears only as a breadcrumb: a parent kept to give its changed
// children a place to hang. Placement is by the after side; only a removed
// item sits where its before side was.
export interface ItemDiff {
  kind: ChangeKind;
  before: Item | null;
  after: Item | null;
  fields: ItemField[];
  children: ItemDiff[];
  // Changed edges this entity is an endpoint of. Every edge appears on BOTH
  // endpoint entries (settled with the user: an edge change genuinely changes
  // both entities' situations, and a flat summary list doesn't scale) — so an
  // edge to an added/removed entity, whose row shows no detail, still
  // surfaces on the surviving end.
  depsAdded: DepChange[];
  depsRemoved: DepChange[];
}

export interface MilestoneDiff {
  kind: ChangeKind; // "unchanged" only mid-computation; never in the result
  before: Milestone | null;
  after: Milestone | null;
  fields: MilestoneField[];
  depsAdded: DepChange[];
  depsRemoved: DepChange[];
}

// A lane's changes: its own fields plus the changed entities inside it. Order
// changes are deliberately one boolean per lane — which ranks changed is noise
// (settled with the user), that something reordered is not, because a restore
// would revert it.
export interface LaneDiff {
  kind: ChangeKind;
  before: Lane | null;
  after: Lane | null;
  fields: LaneField[];
  orderChanged: boolean;
  items: ItemDiff[];
  milestones: MilestoneDiff[];
}

export interface RoadmapDiff {
  // After-side lane order, removed lanes appended last. Only lanes that carry
  // some change appear.
  lanes: LaneDiff[];
  laneOrderChanged: boolean;
  // Schedule edits replace all period rows (new ids every time), so periods
  // diff by value: a relabeled period reads as removed + added.
  periodsAdded: SchedulePeriod[];
  periodsRemoved: SchedulePeriod[];
  // Added edges reference after-side entities, removed edges before-side ones.
  depsAdded: Dependency[];
  depsRemoved: Dependency[];
}

export function isEmptyDiff(d: RoadmapDiff): boolean {
  return (
    d.lanes.length === 0 &&
    !d.laneOrderChanged &&
    d.periodsAdded.length === 0 &&
    d.periodsRemoved.length === 0 &&
    d.depsAdded.length === 0 &&
    d.depsRemoved.length === 0
  );
}

// diffCounts totals the changed items and milestones for the summary strip.
// Breadcrumb parents don't count; a moved or edited entity counts once.
export function diffCounts(d: RoadmapDiff): { added: number; removed: number; modified: number } {
  const c = { added: 0, removed: 0, modified: 0 };
  const bump = (kind: ChangeKind): void => {
    if (kind !== "unchanged") c[kind]++;
  };
  for (const lane of d.lanes) {
    for (const item of lane.items) {
      bump(item.kind);
      for (const child of item.children) bump(child.kind);
    }
    for (const ms of lane.milestones) bump(ms.kind);
  }
  return c;
}

// Labels compare as sets: the renderer shows the added/removed ones, and a
// mere reordering is nothing a user changed.
function sameLabels(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((l) => set.has(l));
}

export function itemChanges(b: Item, a: Item): ItemField[] {
  const out: ItemField[] = [];
  if (b.title !== a.title) out.push("title");
  if (b.description !== a.description) out.push("description");
  if (b.startDate !== a.startDate || b.endDate !== a.endDate) out.push("dates");
  if (b.priority !== a.priority) out.push("priority");
  if (!sameLabels(b.labels, a.labels)) out.push("labels");
  if (b.flagged !== a.flagged) out.push("flagged");
  if (b.tentative !== a.tentative) out.push("tentative");
  if (b.atRisk !== a.atRisk) out.push("atRisk");
  if (b.laneId !== a.laneId) out.push("lane");
  if (b.parentId !== a.parentId) out.push("parent");
  return out;
}

export function milestoneChanges(b: Milestone, a: Milestone): MilestoneField[] {
  const out: MilestoneField[] = [];
  if (b.title !== a.title) out.push("title");
  if (b.description !== a.description) out.push("description");
  if (b.date !== a.date) out.push("date");
  if (b.laneId !== a.laneId) out.push("lane");
  return out;
}

function laneChanges(b: Lane, a: Lane): LaneField[] {
  const out: LaneField[] = [];
  if (b.name !== a.name) out.push("name");
  if (b.color !== a.color) out.push("color");
  return out;
}

// orderDiffers reports whether the entities common to both sequences appear in
// a different relative order. Additions and removals shift ranks without
// reordering anything, so they never trip this.
function orderDiffers(before: number[], after: number[]): boolean {
  const bSet = new Set(before);
  const aSet = new Set(after);
  const common = before.filter((id) => aSet.has(id));
  const commonAfter = after.filter((id) => bSet.has(id));
  return common.join(",") !== commonAfter.join(",");
}

function laneOrderChanged(before: LaneFull, after: LaneFull): boolean {
  if (
    orderDiffers(
      before.items.map((i) => i.id),
      after.items.map((i) => i.id),
    )
  ) {
    return true;
  }
  for (const top of after.items) {
    const prev = before.items.find((t) => t.id === top.id);
    if (!prev) continue;
    if (
      orderDiffers(
        prev.children.map((c) => c.id),
        top.children.map((c) => c.id),
      )
    ) {
      return true;
    }
  }
  return false;
}

function periodKey(p: SchedulePeriod): string {
  return JSON.stringify([p.label, p.startDate, p.endDate]);
}

function depKey(d: Dependency): string {
  return `${d.from.kind}:${d.from.id}>${d.to.kind}:${d.to.id}`;
}

export function diffRoadmaps(before: RoadmapFull, after: RoadmapFull): RoadmapDiff {
  // Flat before-side indexes; `seen` collects every id the after-side walk
  // matched, so what's left is what was removed.
  const beforeItems = new Map<number, Item>();
  const beforeMs = new Map<number, Milestone>();
  for (const lane of before.lanes) {
    for (const top of lane.items) {
      beforeItems.set(top.id, top);
      for (const child of top.children) beforeItems.set(child.id, child);
    }
    for (const ms of lane.milestones) beforeMs.set(ms.id, ms);
  }
  const beforeLanes = new Map(before.lanes.map((l) => [l.id, l]));
  const seenItems = new Set<number>();
  const seenMs = new Set<number>();

  // Every entry goes through these factories so the dependency pass below can
  // find any entity's entry by id, whichever pass created it.
  const itemEntries = new Map<number, ItemDiff>();
  const msEntries = new Map<number, MilestoneDiff>();
  const itemEntry = (
    kind: ChangeKind,
    b: Item | null,
    a: Item | null,
    fields: ItemField[] = [],
  ): ItemDiff => {
    const e: ItemDiff = { kind, before: b, after: a, fields, children: [], depsAdded: [], depsRemoved: [] };
    itemEntries.set((a ?? b)!.id, e);
    return e;
  };
  const msEntry = (
    kind: ChangeKind,
    b: Milestone | null,
    a: Milestone | null,
    fields: MilestoneField[] = [],
  ): MilestoneDiff => {
    const e: MilestoneDiff = { kind, before: b, after: a, fields, depsAdded: [], depsRemoved: [] };
    msEntries.set((a ?? b)!.id, e);
    return e;
  };

  // diffOne classifies one after-side item against its before-side self;
  // null = unchanged.
  const diffOne = (it: Item): ItemDiff | null => {
    seenItems.add(it.id);
    const prev = beforeItems.get(it.id);
    if (!prev) return itemEntry("added", null, it);
    const fields = itemChanges(prev, it);
    if (fields.length === 0) return null;
    return itemEntry("modified", prev, it, fields);
  };

  // Every after-side lane gets a LaneDiff up front (unchanged ones are
  // filtered at the end): the removal pass below needs a place to attach rows
  // to whichever lane they were in.
  const laneDiffs = new Map<number, LaneDiff>();
  // After-side top-level entries by item id, for attaching removed children to
  // their surviving parent.
  const topDiffs = new Map<number, ItemDiff>();

  for (const lane of after.lanes) {
    const prevLane = beforeLanes.get(lane.id) ?? null;
    const items: ItemDiff[] = [];
    for (const top of lane.items) {
      const children: ItemDiff[] = [];
      for (const child of top.children) {
        const d = diffOne(child);
        if (d) children.push(d);
      }
      const own = diffOne(top);
      if (!own && children.length === 0) continue;
      const entry = own ?? itemEntry("unchanged", beforeItems.get(top.id) ?? null, top);
      entry.children = children;
      items.push(entry);
      topDiffs.set(top.id, entry);
    }
    const milestones: MilestoneDiff[] = [];
    for (const ms of lane.milestones) {
      seenMs.add(ms.id);
      const prev = beforeMs.get(ms.id);
      if (!prev) {
        milestones.push(msEntry("added", null, ms));
        continue;
      }
      const fields = milestoneChanges(prev, ms);
      if (fields.length > 0) milestones.push(msEntry("modified", prev, ms, fields));
    }
    const laneFields = prevLane ? laneChanges(prevLane, lane) : [];
    laneDiffs.set(lane.id, {
      kind: prevLane ? (laneFields.length > 0 ? "modified" : "unchanged") : "added",
      before: prevLane,
      after: lane,
      fields: laneFields,
      orderChanged: prevLane ? laneOrderChanged(prevLane, lane) : false,
      items,
      milestones,
    });
  }

  // Removed lanes, appended after the after-side ones.
  const removedLanes: LaneDiff[] = [];
  for (const lane of before.lanes) {
    if (laneDiffs.has(lane.id)) continue;
    const entry: LaneDiff = {
      kind: "removed",
      before: lane,
      after: null,
      fields: [],
      orderChanged: false,
      items: [],
      milestones: [],
    };
    laneDiffs.set(lane.id, entry);
    removedLanes.push(entry);
  }

  // Removal pass: walk the before side and place everything the after-side
  // walk never matched. A removed top-level item keeps its removed children
  // nested under it; a removed child whose parent survives as a top-level
  // entry hangs under that parent (creating the breadcrumb if the parent
  // itself didn't change); anything else — parent nested away or itself gone —
  // falls back to its own top-level removed row. Rows land in the lane the
  // entity was in, appended after that lane's after-side rows.
  const removedDiff = (it: Item): ItemDiff => itemEntry("removed", it, null);
  for (const lane of before.lanes) {
    const laneDiff = laneDiffs.get(lane.id)!;
    for (const top of lane.items) {
      const removedChildren = top.children.filter((c) => !seenItems.has(c.id)).map(removedDiff);
      if (!seenItems.has(top.id)) {
        const entry = removedDiff(top);
        entry.children = removedChildren;
        laneDiff.items.push(entry);
        continue;
      }
      if (removedChildren.length === 0) continue;
      const parentDiff = topDiffs.get(top.id);
      if (parentDiff) {
        parentDiff.children.push(...removedChildren);
      } else {
        const afterTop = after.lanes
          .flatMap((l) => l.items)
          .find((candidate) => candidate.id === top.id);
        if (afterTop) {
          const entry = itemEntry("unchanged", top, afterTop);
          entry.children = removedChildren;
          const target = laneDiffs.get(afterTop.laneId) ?? laneDiff;
          target.items.push(entry);
          topDiffs.set(top.id, entry);
        } else {
          laneDiff.items.push(...removedChildren);
        }
      }
    }
    for (const ms of lane.milestones) {
      if (seenMs.has(ms.id)) continue;
      laneDiff.milestones.push(msEntry("removed", ms, null));
    }
  }

  // Dependencies diff by endpoint pair (a deleted-and-recreated edge is the
  // same edge; its row id is not its identity), and each changed edge attaches
  // to BOTH endpoints' entries. An added edge's endpoints live on the after
  // side; a removed edge's endpoints are found on the after side when they
  // survive, otherwise on their removed entries — the removal pass above has
  // already registered every removed entity. An endpoint that didn't
  // otherwise change gets a carrier entry at its after-side position.
  const { added: depsAdded, removed: depsRemoved } = diffByKey(
    before.dependencies,
    after.dependencies,
    depKey,
  );
  const ensureItem = (id: number): ItemDiff => {
    const existing = itemEntries.get(id);
    if (existing) return existing;
    for (const lane of after.lanes) {
      for (const top of lane.items) {
        if (top.id === id) {
          const entry = itemEntry("unchanged", beforeItems.get(id) ?? null, top);
          laneDiffs.get(lane.id)!.items.push(entry);
          topDiffs.set(id, entry);
          return entry;
        }
        const child = top.children.find((c) => c.id === id);
        if (child) {
          const entry = itemEntry("unchanged", beforeItems.get(id) ?? null, child);
          ensureItem(top.id).children.push(entry);
          return entry;
        }
      }
    }
    // Unreachable: an edge only ever references entities of its own version.
    throw new Error(`dependency endpoint refers to unknown item ${id}`);
  };
  const ensureMs = (id: number): MilestoneDiff => {
    const existing = msEntries.get(id);
    if (existing) return existing;
    for (const lane of after.lanes) {
      const ms = lane.milestones.find((m) => m.id === id);
      if (ms) {
        const entry = msEntry("unchanged", beforeMs.get(id) ?? null, ms);
        laneDiffs.get(lane.id)!.milestones.push(entry);
        return entry;
      }
    }
    throw new Error(`dependency endpoint refers to unknown milestone ${id}`);
  };
  const endpoint = (ref: DependencyRef): { depsAdded: DepChange[]; depsRemoved: DepChange[] } =>
    ref.kind === "milestone" ? ensureMs(ref.id) : ensureItem(ref.id);
  for (const edge of depsAdded) {
    endpoint(edge.from).depsAdded.push({ other: edge.to, incoming: false });
    endpoint(edge.to).depsAdded.push({ other: edge.from, incoming: true });
  }
  for (const edge of depsRemoved) {
    endpoint(edge.from).depsRemoved.push({ other: edge.to, incoming: false });
    endpoint(edge.to).depsRemoved.push({ other: edge.from, incoming: true });
  }

  // An entity whose edge set changed reads as changed; one that is itself
  // added or removed keeps its kind — the edges ride along in its detail.
  for (const e of itemEntries.values()) {
    if (e.depsAdded.length === 0 && e.depsRemoved.length === 0) continue;
    if (e.kind === "unchanged") e.kind = "modified";
    if (e.kind === "modified" && !e.fields.includes("deps")) e.fields.push("deps");
  }
  for (const e of msEntries.values()) {
    if (e.depsAdded.length === 0 && e.depsRemoved.length === 0) continue;
    if (e.kind === "unchanged") e.kind = "modified";
    if (e.kind === "modified" && !e.fields.includes("deps")) e.fields.push("deps");
  }

  const lanes = [
    ...after.lanes.map((l) => laneDiffs.get(l.id)!),
    ...removedLanes,
  ].filter(
    (l) =>
      l.kind !== "unchanged" || l.orderChanged || l.items.length > 0 || l.milestones.length > 0,
  );

  // Periods by value: schedule edits replace all rows, so ids mean nothing.
  const { added: periodsAdded, removed: periodsRemoved } = diffByKey(
    before.periods,
    after.periods,
    periodKey,
  );

  return {
    lanes,
    laneOrderChanged: orderDiffers(
      before.lanes.map((l) => l.id),
      after.lanes.map((l) => l.id),
    ),
    periodsAdded,
    periodsRemoved,
    depsAdded,
    depsRemoved,
  };
}

// diffByKey splits two collections into added/removed by a value key,
// tolerating duplicate keys by count.
function diffByKey<T>(
  before: T[],
  after: T[],
  key: (v: T) => string,
): { added: T[]; removed: T[] } {
  const counts = new Map<string, number>();
  for (const v of before) {
    const k = key(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const added: T[] = [];
  for (const v of after) {
    const k = key(v);
    const n = counts.get(k) ?? 0;
    if (n > 0) counts.set(k, n - 1);
    else added.push(v);
  }
  const removed: T[] = [];
  const remaining = new Map(counts);
  for (const v of before) {
    const k = key(v);
    const n = remaining.get(k) ?? 0;
    if (n > 0) {
      removed.push(v);
      remaining.set(k, n - 1);
    }
  }
  return { added, removed };
}
