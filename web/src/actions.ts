// Actions mutate the client state and keep the server in sync. Updates and
// deletes are optimistic: apply locally, call the API, roll back on failure.
// Creates wait for the server (it assigns the ID).

import { api } from "./api";
import { state } from "./state";
import { dayOf, isoOf, todayDay } from "./timescale";
import { toast } from "./toast";
import type { Item, ItemFull, ItemPatch, MilestonePatch } from "./types";

// Default item length, in days added to the start (end date is inclusive, so
// this spans DEFAULT_ITEM_SPAN + 1 days). Shared by new top-level items and,
// as an upper bound, by new children.
const DEFAULT_ITEM_SPAN = 27;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function optimistic(mutate: () => void, call: () => Promise<unknown>): Promise<boolean> {
  const snap = state.snapshot();
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

function renumber(items: Item[]): void {
  items.forEach((it, i) => {
    it.rank = i;
  });
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

export const actions = {
  async loadRoadmaps(): Promise<void> {
    state.roadmaps = await api.listRoadmaps();
  },

  async selectRoadmap(id: number): Promise<void> {
    try {
      state.current = await api.getRoadmap(id);
      state.clearSelection();
      state.focusLabel = null; // labels are per-roadmap; don't carry focus across
      state.loadHiddenLanes();
      state.scrollToToday = true;
      localStorage.setItem("roadie.roadmap", String(id));
      state.notify();
    } catch (e) {
      toast(errMsg(e), true);
    }
  },

  async createRoadmap(name: string): Promise<void> {
    try {
      const rm = await api.createRoadmap(name);
      await this.loadRoadmaps();
      await this.selectRoadmap(rm.id);
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
  },

  async deleteRoadmap(): Promise<void> {
    if (!state.current) return;
    const id = state.current.id;
    try {
      await api.deleteRoadmap(id);
      state.roadmaps = state.roadmaps.filter((r) => r.id !== id);
      state.current = null;
      state.clearSelection();
      const next = state.roadmaps[0];
      if (next) await this.selectRoadmap(next.id);
      else state.notify();
    } catch (e) {
      toast(errMsg(e), true);
    }
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
    if (!state.current) return;
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
        if (state.current) state.current.lanes = state.current.lanes.filter((l) => l.id !== id);
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
  // starts at its parent's start and runs the default span, but never past the
  // parent's own end — so a short parent yields a short child.
  async addItem(laneId: number, parentId: number | null): Promise<void> {
    const today = todayDay();
    let startDay = today;
    let endDay = today + DEFAULT_ITEM_SPAN;
    if (parentId !== null) {
      const parentLoc = state.findItem(parentId);
      if (parentLoc) {
        startDay = dayOf(parentLoc.item.startDate);
        endDay = Math.min(startDay + DEFAULT_ITEM_SPAN, dayOf(parentLoc.item.endDate));
      }
    }
    try {
      const item = await api.createItem(laneId, {
        title: parentId ? "New child item" : "New item",
        description: "",
        startDate: isoOf(startDay),
        endDate: isoOf(endDay),
        parentId,
      });
      // The server appends new items to their container.
      const lane = state.findLane(item.laneId);
      if (lane) {
        if (item.parentId !== null) {
          const parent = lane.items.find((i) => i.id === item.parentId);
          if (parent) parent.children.push(item);
        } else {
          lane.items.push({ ...item, children: [] });
        }
      }
      state.selectItem(item.id);
      state.notify();
    } catch (e) {
      toast(errMsg(e), true);
    }
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

  async deleteItem(id: number): Promise<void> {
    await optimistic(
      () => {
        const loc = state.findItem(id);
        if (!loc) return;
        if (loc.parent) {
          loc.parent.children = loc.parent.children.filter((c) => c.id !== id);
          renumber(loc.parent.children);
        } else {
          loc.lane.items = loc.lane.items.filter((i) => i.id !== id);
          renumber(loc.lane.items);
        }
        if (state.selectedItemId === id) state.selectedItemId = null;
      },
      () => api.deleteItem(id),
    );
  },

  // addMilestone creates a milestone dated today and selects it for editing.
  // Not optimistic (the server assigns the ID).
  async addMilestone(laneId: number): Promise<void> {
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
        if (state.selectedMilestoneId === id) state.selectedMilestoneId = null;
      },
      () => api.deleteMilestone(id),
    );
  },
};
