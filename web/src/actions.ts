// Actions mutate the client state and keep the server in sync. Updates and
// deletes are optimistic: apply locally, call the API, and restore roadmap data
// on failure. Transient view state such as selection is not transactional.
// Creates wait for the server (it assigns the ID).

import { api } from "./api";
import { connectEvents } from "./events";
import { state } from "./state";
import { dayOf, isoOf, todayDay } from "./timescale";
import { toast } from "./toast";
import type {
  DependencyRef,
  Item,
  ItemFull,
  ItemPatch,
  MilestonePatch,
  NewSchedulePeriod,
  Visibility,
} from "./types";
import { setRoadmapUrl } from "./url";

type ItemMetadataPatch = Pick<ItemPatch, "priority" | "flagged" | "tentative" | "atRisk">;

// Default length of a new top-level item, in days added to the start (end date
// is inclusive, so this spans DEFAULT_ITEM_SPAN + 1 days). New children don't
// use it at all — they inherit their parent's exact range.
const DEFAULT_ITEM_SPAN = 27;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function optimistic(mutate: () => void, call: () => Promise<unknown>): Promise<boolean> {
  // Single choke point: no mutation persists while previewing a snapshot (its
  // IDs are historical and could hit the wrong live row). Silently no-op — the
  // snapshot banner already explains why edits don't take.
  if (state.preview) return false;
  const snap = state.snapshot(); // Roadmap data only; selection/view state is not part of rollback.
  mutate();
  state.notify();
  try {
    await call();
    return true;
  } catch (e) {
    state.restore(snap);
    toast(errMsg(e), true);
    return false;
  }
}

// reloadLive re-fetches the live roadmap into `current`, used when leaving a
// snapshot preview. Unlike selectRoadmap it keeps the scroll position and view
// prefs (they never changed while viewing) and doesn't touch history/preview,
// so the caller controls those. Throws on failure.
async function reloadLive(): Promise<void> {
  if (!state.current) return;
  state.current = await api.getRoadmap(state.current.id);
  state.stale = false; // fresh live data supersedes any pending remote change
  state.clearSelection();
}

function renumber(items: Item[]): void {
  items.forEach((it, i) => {
    it.rank = i;
  });
}

// insertItem places a freshly created item into its local container at the rank
// the server assigned it — the response is the authority, since the requested
// slot is clamped there. Ranks are rewritten after, as the frontend relies on
// rank == array index.
function insertItem<T extends Item>(arr: T[], item: T): void {
  arr.splice(item.rank, 0, item);
  renumber(arr);
}

// applyItemPatch mirrors the server's UpdateItem logic on the local state:
// children adopt their parent's lane, children follow a moving parent, and
// container arrays stay ordered with dense ranks.
function applyItemPatch(id: number, patch: ItemPatch): void {
  const loc = state.findItem(id);
  if (!loc || !state.current) return;
  const { item } = loc;

  if (patch.title !== undefined) item.title = patch.title;
  if (patch.description !== undefined) item.description = patch.description;
  if (patch.startDate !== undefined) item.startDate = patch.startDate;
  if (patch.endDate !== undefined) item.endDate = patch.endDate;
  if (patch.priority !== undefined) item.priority = patch.priority;
  if (patch.labels !== undefined) item.labels = patch.labels;
  if (patch.flagged !== undefined) item.flagged = patch.flagged;
  if (patch.tentative !== undefined) item.tentative = patch.tentative;
  if (patch.atRisk !== undefined) item.atRisk = patch.atRisk;

  const newParentId = patch.parentId !== undefined ? patch.parentId : item.parentId;
  let newLaneId = patch.laneId !== undefined ? patch.laneId : item.laneId;
  const newParent = newParentId !== null ? state.findItem(newParentId) : null;
  if (newParent) newLaneId = newParent.item.laneId;

  const structural = newParentId !== item.parentId || newLaneId !== item.laneId;
  if (!structural && patch.rank === undefined) return;

  // Remove from the old container.
  const oldArr = loc.parent ? loc.parent.children : loc.lane.items;
  const oldIdx = oldArr.findIndex((i) => i.id === id);
  if (oldIdx >= 0) oldArr.splice(oldIdx, 1);
  renumber(oldArr);
  item.parentId = newParentId;
  item.laneId = newLaneId;

  // Insert into the new container at the requested position (append default).
  if (newParent) {
    const parentFull = newParent.item as ItemFull;
    const { children: _drop, ...plain } = item as ItemFull;
    const arr = parentFull.children;
    const idx = patch.rank !== undefined ? Math.max(0, Math.min(patch.rank, arr.length)) : arr.length;
    arr.splice(idx, 0, plain as Item);
    renumber(arr);
  } else {
    const lane = state.findLane(newLaneId);
    if (lane) {
      const full = item as ItemFull;
      if (!full.children) full.children = [];
      for (const c of full.children) c.laneId = newLaneId;
      const idx =
        patch.rank !== undefined ? Math.max(0, Math.min(patch.rank, lane.items.length)) : lane.items.length;
      lane.items.splice(idx, 0, full);
      renumber(lane.items);
    }
  }
}

// dropDepsTouching removes the dependency edges referencing any of the given
// endpoints — the local mirror of the DB's FK cascade, so an optimistic delete
// of an item, milestone or lane doesn't leave dangling edges until the next
// refetch.
function dropDepsTouching(items: Set<number>, milestones: Set<number>): void {
  if (!state.current) return;
  const hit = (r: DependencyRef): boolean =>
    r.kind === "item" ? items.has(r.id) : milestones.has(r.id);
  state.current.dependencies = state.current.dependencies.filter(
    (d) => !hit(d.from) && !hit(d.to),
  );
}

export const actions = {
  async loadRoadmaps(): Promise<void> {
    state.roadmaps = await api.listRoadmaps();
  },

  async selectRoadmap(id: number): Promise<void> {
    try {
      state.current = await api.getRoadmap(id);
      state.clearSelection();
      state.history = null; // switching roadmaps exits history browsing
      state.preview = null;
      state.contributors = []; // belong to the roadmap we just left
      state.stale = false; // a fresh load can't be stale
      state.resetFilter(); // labels and dependency conflicts are per-roadmap; forget the last one too
      state.loadHiddenLanes();
      state.loadCollapsed();
      state.loadWbsMsCollapsed();
      state.scrollToToday = true;
      localStorage.setItem("roadie.roadmap", String(id));
      setRoadmapUrl(state.current);
      connectEvents(id); // (re)subscribe to this roadmap's live change stream
      state.notify();
    } catch (e) {
      toast(errMsg(e), true);
    }
  },

  // refreshFromServer re-fetches the live roadmap after a remote change, keeping
  // the user's selection and view prefs where the rows they point at still
  // exist (unlike selectRoadmap, which resets everything). Driven by the SSE
  // change listener; no-ops while previewing a snapshot. Throws on failure so
  // the caller can leave `stale` set and retry on the next event.
  async refreshFromServer(): Promise<void> {
    if (!state.current || state.preview) return;
    state.current = await api.getRoadmap(state.current.id);
    // Drop selections whose targets vanished remotely.
    for (const sid of [...state.selectedItemIds]) {
      if (!state.findItem(sid)) state.deselectItem(sid);
    }
    if (state.selectedMilestoneId !== null && !state.findMilestone(state.selectedMilestoneId)) {
      state.selectedMilestoneId = null;
    }
    state.loadHiddenLanes(); // prune view prefs for lanes/parents that changed
    state.loadCollapsed();
    state.loadWbsMsCollapsed();
    state.stale = false;
    state.notify();
  },

  async createRoadmap(name: string, visibility: Visibility = "public"): Promise<void> {
    try {
      const rm = await api.createRoadmap(name, visibility);
      await this.loadRoadmaps();
      await this.selectRoadmap(rm.id);
    } catch (e) {
      toast(errMsg(e), true);
    }
  },

  // setVisibility makes the current roadmap private or public. Not optimistic:
  // it is a rare, deliberate action whose whole point is the answer, and only
  // the owner may do it — a rejection has to be visible rather than flicker.
  async setVisibility(visibility: Visibility): Promise<void> {
    if (!state.current) return;
    try {
      const rm = await api.setVisibility(state.current.id, visibility);
      if (state.current?.id === rm.id) state.current.visibility = rm.visibility;
      const listed = state.roadmaps.find((r) => r.id === rm.id);
      if (listed) listed.visibility = rm.visibility;
      state.notify();
      toast(visibility === "private" ? "Roadmap is now private" : "Roadmap is now public");
    } catch (e) {
      toast(errMsg(e), true);
    }
  },

  // duplicateRoadmap deep-copies the current roadmap and switches to the copy.
  // Not optimistic: the server assigns the IDs and may adjust the name.
  async duplicateRoadmap(name: string): Promise<void> {
    if (!state.current) return;
    try {
      const rm = await api.duplicateRoadmap(state.current.id, name);
      await this.loadRoadmaps();
      await this.selectRoadmap(rm.id);
      toast(`Duplicated as "${rm.name}"`);
    } catch (e) {
      toast(errMsg(e), true);
    }
  },

  async renameRoadmap(name: string): Promise<void> {
    if (!state.current) return;
    const id = state.current.id;
    await optimistic(
      () => {
        if (state.current) state.current.name = name;
        const rm = state.roadmaps.find((r) => r.id === id);
        if (rm) rm.name = name;
      },
      () => api.renameRoadmap(id, name),
    );
    // Refresh the decorative name slug in the address bar (id is unchanged).
    setRoadmapUrl(state.current);
  },

  // deleteRoadmap moves the current roadmap to the trash and leaves it: the
  // roadmap keeps existing server-side, so this drops it from the picker and
  // switches to whatever is left, exactly as a real delete used to.
  async deleteRoadmap(): Promise<void> {
    if (!state.current) return;
    const id = state.current.id;
    const name = state.current.name;
    try {
      await api.deleteRoadmap(id);
      state.roadmaps = state.roadmaps.filter((r) => r.id !== id);
      state.current = null;
      state.clearSelection();
      const next = state.roadmaps[0];
      if (next) await this.selectRoadmap(next.id);
      else {
        setRoadmapUrl(null);
        state.notify();
      }
      toast(`Moved "${name}" to the trash`);
    } catch (e) {
      toast(errMsg(e), true);
    }
  },

  // restoreRoadmap brings a roadmap back from the trash and opens it — the
  // point of restoring is nearly always to get back to the thing you deleted.
  // Throws rather than toasting so the trash dialog can stay open and keep
  // showing the entry when the restore fails.
  async restoreRoadmap(id: number): Promise<void> {
    const rm = await api.restoreRoadmap(id);
    await this.loadRoadmaps();
    await this.selectRoadmap(rm.id);
    toast(`Restored "${rm.name}"`);
  },

  // exportRoadmap triggers a file download via the server's export endpoint.
  // The browser handles the download; the server's Content-Disposition names
  // the file.
  exportRoadmap(): void {
    if (!state.current) return;
    const a = document.createElement("a");
    a.href = api.exportRoadmapUrl(state.current.id);
    a.download = ""; // let the server's Content-Disposition set the filename
    document.body.append(a);
    a.click();
    a.remove();
  },

  // importRoadmap uploads a previously exported file as a new roadmap and
  // switches to it. Name collisions are resolved server-side (" (2)" suffix).
  async importRoadmap(file: File): Promise<void> {
    try {
      const data: unknown = JSON.parse(await file.text());
      const rm = await api.importRoadmap(data);
      await this.loadRoadmaps();
      await this.selectRoadmap(rm.id);
      toast(`Imported "${rm.name}"`);
    } catch (e) {
      toast(errMsg(e), true);
    }
  },

  async addLane(name: string): Promise<void> {
    if (!state.current || state.preview) return;
    try {
      const lane = await api.createLane(state.current.id, name);
      state.current.lanes.push({ ...lane, items: [], milestones: [] });
      state.notify();
    } catch (e) {
      toast(errMsg(e), true);
    }
  },

  async renameLane(id: number, name: string): Promise<void> {
    await optimistic(
      () => {
        const lane = state.findLane(id);
        if (lane) lane.name = name;
      },
      () => api.updateLane(id, { name }),
    );
  },

  async setLaneColor(id: number, color: string): Promise<void> {
    await optimistic(
      () => {
        const lane = state.findLane(id);
        if (lane) lane.color = color;
      },
      () => api.updateLane(id, { color }),
    );
  },

  async deleteLane(id: number): Promise<void> {
    await optimistic(
      () => {
        if (!state.current) return;
        // Everything in the lane cascades away, so its endpoints' edges do too.
        const lane = state.findLane(id);
        const items = new Set<number>();
        const milestones = new Set<number>();
        for (const it of lane?.items ?? []) {
          items.add(it.id);
          for (const c of it.children) items.add(c.id);
        }
        for (const m of lane?.milestones ?? []) milestones.add(m.id);
        state.current.lanes = state.current.lanes.filter((l) => l.id !== id);
        dropDepsTouching(items, milestones);
      },
      () => api.deleteLane(id),
    );
  },

  async reorderLanes(laneIds: number[]): Promise<void> {
    if (!state.current) return;
    const rmId = state.current.id;
    await optimistic(
      () => {
        if (!state.current) return;
        const byId = new Map(state.current.lanes.map((l) => [l.id, l]));
        const lanes = [];
        for (const id of laneIds) {
          const lane = byId.get(id);
          if (lane) lanes.push(lane);
        }
        state.current.lanes = lanes;
      },
      () => api.setLaneOrder(rmId, laneIds),
    );
  },

  // addItem creates an item with default dates and selects it for editing.
  // Top-level items span DEFAULT_ITEM_SPAN days from today. A child instead
  // inherits its parent's exact start and end dates. If explicit dates are
  // provided (e.g. for siblings), the new item uses those exact dates.
  //
  // Returns the created item, or null if nothing was created — callers that
  // act on the result (the "n" shortcut focuses its title) must not fire after
  // a rejected create, and a failure here toasts rather than throwing.
  //
  // `rank` is the slot the new item should occupy in its container (omitted =
  // append). It goes out with the create itself, so the sibling shift and the
  // insert share one transaction server-side — a follow-up rank PATCH would
  // leave a window for a concurrent create in the same container to land in
  // between, and would make a create-then-move visible to every other session.
  async addItem(
    laneId: number,
    parentId: number | null,
    opts: { dates?: { start: string; end: string }; rank?: number } = {},
  ): Promise<Item | null> {
    if (state.preview) return null;
    const today = todayDay();
    let startDay = today;
    let endDay = today + DEFAULT_ITEM_SPAN;

    if (opts.dates) {
      startDay = dayOf(opts.dates.start);
      endDay = dayOf(opts.dates.end);
    } else if (parentId !== null) {
      const parentLoc = state.findItem(parentId);
      if (parentLoc) {
        startDay = dayOf(parentLoc.item.startDate);
        endDay = dayOf(parentLoc.item.endDate);
      }
    }
    let item: Item;
    try {
      item = await api.createItem(laneId, {
        title: parentId ? "New child item" : "New item",
        description: "",
        startDate: isoOf(startDay),
        endDate: isoOf(endDay),
        parentId,
        rank: opts.rank,
      });
    } catch (e) {
      toast(errMsg(e), true);
      return null;
    }

    const lane = state.findLane(item.laneId);
    if (lane) {
      if (item.parentId !== null) {
        const parent = lane.items.find((i) => i.id === item.parentId);
        if (parent) insertItem(parent.children, item);
        // A child added to a folded parent would be created invisible — and
        // selected for editing, which the panel would then show off-chart.
        state.setCollapsed(item.parentId, false);
      } else {
        insertItem(lane.items, { ...item, children: [] });
      }
    }
    // The same hazard one branch up, from the other direction: a new item
    // carries no labels and neither signal, so it matches no filter and would
    // be created invisible — and selected for editing, which the panel would
    // then show off-chart.
    if (!state.matchesFilter(item)) state.filter = null;
    state.selectItem(item.id);
    state.notify();
    return item;
  },

  async updateItem(id: number, patch: ItemPatch): Promise<void> {
    await optimistic(
      () => applyItemPatch(id, patch),
      () => api.updateItem(id, patch),
    );
  },

  // moveItemWithChildren patches a parent item and shifts each child's dates
  // by the same number of days, so children follow a dragged parent instead
  // of snapping back to their stored dates.
  async moveItemWithChildren(id: number, patch: ItemPatch, dayDelta: number): Promise<void> {
    const loc = state.findItem(id);
    const children = loc ? (loc.item as ItemFull).children : [];
    const childPatches = children.map((c) => ({
      id: c.id,
      patch: {
        startDate: isoOf(dayOf(c.startDate) + dayDelta),
        endDate: isoOf(dayOf(c.endDate) + dayDelta),
      } satisfies ItemPatch,
    }));
    await optimistic(
      () => {
        applyItemPatch(id, patch);
        for (const cp of childPatches) applyItemPatch(cp.id, cp.patch);
      },
      () =>
        Promise.all([
          api.updateItem(id, patch),
          ...childPatches.map((cp) => api.updateItem(cp.id, cp.patch)),
        ]),
    );
  },

  // shiftItems moves several items in time by the same day-delta, leaving
  // their container, parent, and rank untouched. Backs group drag: each item
  // gets a start/end-only PATCH, applied optimistically as one batch.
  async shiftItems(ids: number[], dayDelta: number): Promise<void> {
    if (dayDelta === 0 || ids.length === 0) return;
    const patches: { id: number; patch: ItemPatch }[] = [];
    for (const id of ids) {
      const loc = state.findItem(id);
      if (!loc) continue;
      patches.push({
        id,
        patch: {
          startDate: isoOf(dayOf(loc.item.startDate) + dayDelta),
          endDate: isoOf(dayOf(loc.item.endDate) + dayDelta),
        },
      });
    }
    await optimistic(
      () => {
        for (const p of patches) applyItemPatch(p.id, p.patch);
      },
      () => Promise.all(patches.map((p) => api.updateItem(p.id, p.patch))),
    );
  },

  // updateItemMetadata applies one scalar patch to several explicitly selected items.
  // It backs the multi-selection metadata controls: one optimistic apply and
  // rollback, while the server keeps its deliberately small per-item PATCH.
  async updateItemMetadata(ids: number[], patch: ItemMetadataPatch): Promise<void> {
    if (ids.length === 0) return;
    await optimistic(
      () => {
        for (const id of ids) applyItemPatch(id, patch);
      },
      () => Promise.all(ids.map((id) => api.updateItem(id, patch))),
    );
  },

  // setFlagged backs both the panel chip and the "!" shortcut. It retains the
  // named action because flagging a whole selection is also a keyboard command;
  // the underlying batch mechanics are shared with the other simple metadata.
  async setFlagged(ids: number[], flagged: boolean): Promise<void> {
    await actions.updateItemMetadata(ids, { flagged });
  },

  // deleteItems removes one or more items. The server cascades a parent's
  // children away with it, which the local removal gets for free: the parent
  // carries its `children` array. `state.toggleItem` guarantees a parent and
  // its child are never both selected, so the ids always name disjoint
  // containers and nothing is removed twice.
  //
  // Batched like shiftItems/updateItemMetadata rather than looped through a
  // single-delete action: one optimistic apply, one rollback, one toast.
  async deleteItems(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await optimistic(
      () => {
        const gone = new Set<number>();
        for (const id of ids) {
          const loc = state.findItem(id);
          if (!loc) continue;
          gone.add(id);
          if (loc.parent) {
            loc.parent.children = loc.parent.children.filter((c) => c.id !== id);
            renumber(loc.parent.children);
          } else {
            // The parent's children cascade away with it, edges included.
            for (const c of (loc.item as ItemFull).children ?? []) gone.add(c.id);
            loc.lane.items = loc.lane.items.filter((i) => i.id !== id);
            renumber(loc.lane.items);
          }
          state.deselectItem(id);
        }
        dropDepsTouching(gone, new Set());
      },
      () => Promise.all(ids.map((id) => api.deleteItem(id))),
    );
  },

  // addMilestone creates a milestone dated today and selects it for editing.
  // Not optimistic (the server assigns the ID).
  async addMilestone(laneId: number): Promise<void> {
    if (state.preview) return;
    try {
      const milestone = await api.createMilestone(laneId, {
        title: "New milestone",
        description: "",
        date: isoOf(todayDay()),
      });
      const lane = state.findLane(milestone.laneId);
      if (lane) {
        lane.milestones.push(milestone);
        lane.milestones.sort((a, b) => a.date.localeCompare(b.date));
      }
      state.selectMilestone(milestone.id);
      state.notify();
    } catch (e) {
      toast(errMsg(e), true);
    }
  },

  async updateMilestone(id: number, patch: MilestonePatch): Promise<void> {
    await optimistic(
      () => {
        const loc = state.findMilestone(id);
        if (!loc) return;
        const { milestone } = loc;
        if (patch.title !== undefined) milestone.title = patch.title;
        if (patch.description !== undefined) milestone.description = patch.description;
        if (patch.date !== undefined) {
          milestone.date = patch.date;
          loc.lane.milestones.sort((a, b) => a.date.localeCompare(b.date));
        }
      },
      () => api.updateMilestone(id, patch),
    );
  },

  async deleteMilestone(id: number): Promise<void> {
    await optimistic(
      () => {
        const loc = state.findMilestone(id);
        if (!loc) return;
        loc.lane.milestones = loc.lane.milestones.filter((m) => m.id !== id);
        dropDepsTouching(new Set(), new Set([id]));
        if (state.selectedMilestoneId === id) state.selectedMilestoneId = null;
      },
      () => api.deleteMilestone(id),
    );
  },

  // addDependency creates the edge "to depends on from". Not optimistic, and
  // not only because the server assigns the id: the server is the cycle judge,
  // and its rejection carries the diagnostic that explains the contradiction
  // ('"C" already depends on "A": …') — that must surface as a toast, not
  // flicker in and out of the panel. Returns true on success.
  async addDependency(from: DependencyRef, to: DependencyRef): Promise<boolean> {
    if (state.preview || !state.current) return false;
    try {
      const dep = await api.createDependency(state.current.id, from, to);
      state.current.dependencies.push(dep);
      state.notify();
      return true;
    } catch (e) {
      toast(errMsg(e), true);
      return false;
    }
  },

  async removeDependency(id: number): Promise<void> {
    await optimistic(
      () => {
        if (!state.current) return;
        state.current.dependencies = state.current.dependencies.filter((d) => d.id !== id);
      },
      () => api.deleteDependency(id),
    );
  },

  // replaceSchedule swaps the roadmap's entire schedule for `periods` (an empty
  // list clears it). Server-authoritative (it assigns ids and rejects overlaps),
  // so it is not optimistic: the returned, validated periods replace state.
  // No-op while previewing a snapshot.
  //
  // The rejection is handed back rather than toasted: this one is the only
  // mutation whose caller is a modal, and "these two periods overlap" is a
  // verdict on the text still on screen — the same kind of thing as the parse
  // errors above it, and a toast behind the dialog's backdrop besides.
  async replaceSchedule(
    periods: NewSchedulePeriod[],
  ): Promise<{ saved: boolean; error?: string }> {
    if (state.preview || !state.current) return { saved: false };
    try {
      const saved = await api.replaceSchedule(state.current.id, periods);
      state.current.periods = saved;
      state.notify();
      return { saved: true };
    } catch (e) {
      return { saved: false, error: errMsg(e) };
    }
  },

  // Version history (snapshots).

  // openHistory loads the current roadmap's snapshots and opens the history
  // side-list. The live roadmap stays on screen until a snapshot is picked.
  async openHistory(): Promise<void> {
    if (!state.current) return;
    try {
      // Contributors are a separate fetch (they are editing metadata, not part
      // of the roadmap payload), so load both in parallel and open once.
      const [snaps, contributors] = await Promise.all([
        api.listSnapshots(state.current.id),
        api.listContributors(state.current.id),
      ]);
      state.history = snaps;
      state.contributors = contributors;
      state.notify();
    } catch (e) {
      toast(errMsg(e), true);
    }
  },

  // saveCheckpoint captures the live roadmap under a name. A named snapshot is
  // exempt from auto-pruning, so a checkpoint is the state you can still find
  // and recognise long after the timestamps around it have been thinned out.
  // Refused while previewing: the capture would be of the live roadmap, not of
  // the older version on screen. Nothing on the chart changes, so this only
  // refreshes an open history list.
  async saveCheckpoint(name: string): Promise<boolean> {
    if (!state.current || state.preview) return false;
    try {
      const snap = await api.createSnapshot(state.current.id, name);
      // The list is newest-first and this capture is the newest.
      if (state.history !== null) state.history = [snap, ...state.history];
      toast(`Saved checkpoint "${name}"`);
      state.notify();
      return true;
    } catch (e) {
      toast(errMsg(e), true);
      return false;
    }
  },

  // nameSnapshot names a capture that already exists, from the preview banner:
  // you scrub to a state, recognise it, and only then keep it. The server
  // promotes it to a manual snapshot, so naming is what makes it survive
  // pruning — not a label on something already permanent.
  async nameSnapshot(snapshotId: number, name: string): Promise<boolean> {
    try {
      const named = await api.renameSnapshot(snapshotId, name);
      if (state.history !== null) {
        state.history = state.history.map((s) => (s.id === named.id ? named : s));
      }
      toast(`Saved checkpoint "${name}"`);
      state.notify();
      return true;
    } catch (e) {
      toast(errMsg(e), true);
      return false;
    }
  },

  // closeHistory leaves history browsing entirely. If a snapshot was being
  // previewed, the live roadmap is reloaded to discard it.
  async closeHistory(): Promise<void> {
    try {
      if (state.preview) await reloadLive();
    } catch (e) {
      toast(errMsg(e), true);
    }
    state.preview = null;
    state.history = null;
    state.contributors = [];
    state.notify();
  },

  // viewSnapshot loads a snapshot's contents into `current` for read-only
  // viewing (live scrub). Nothing is lost: the live roadmap is reloaded from
  // the server whenever preview is left.
  async viewSnapshot(snapshotId: number, createdAt: string): Promise<void> {
    try {
      const full = await api.getSnapshot(snapshotId);
      state.current = full;
      state.preview = { snapshotId, createdAt };
      state.clearSelection();
      state.notify();
    } catch (e) {
      toast(errMsg(e), true);
    }
  },

  // backToCurrent leaves preview (shows the live roadmap again) but keeps the
  // history list open, so the user can pick another snapshot.
  async backToCurrent(): Promise<void> {
    if (!state.preview) return;
    try {
      await reloadLive();
      state.preview = null;
      state.notify();
    } catch (e) {
      toast(errMsg(e), true);
    }
  },

  // restoreSnapshot replaces the roadmap with the snapshot's contents (the
  // server keeps a snapshot of the pre-restore state), then exits history and
  // reloads the now-restored roadmap.
  async restoreSnapshot(snapshotId: number): Promise<void> {
    try {
      const rm = await api.restoreSnapshot(snapshotId);
      state.history = null;
      state.preview = null;
      await this.selectRoadmap(rm.id);
      toast("Restored this version");
    } catch (e) {
      toast(errMsg(e), true);
    }
  },
};
