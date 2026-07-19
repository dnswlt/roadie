// Actions mutate the client state and keep the server in sync. Updates and
// deletes are optimistic: apply locally, call the API, roll back on failure.
// Creates wait for the server (it assigns the ID).

import { api } from "./api";
import { state } from "./state";
import { dayOf, isoOf, todayDay } from "./timescale";
import { toast } from "./toast";
import type { Item, ItemFull, ItemPatch } from "./types";

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
      state.selectedItemId = null;
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
      state.selectedItemId = null;
      const next = state.roadmaps[0];
      if (next) await this.selectRoadmap(next.id);
      else state.notify();
    } catch (e) {
      toast(errMsg(e), true);
    }
  },

  async addLane(name: string): Promise<void> {
    if (!state.current) return;
    try {
      const lane = await api.createLane(state.current.id, name);
      state.current.lanes.push({ ...lane, items: [] });
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
  async addItem(laneId: number, parentId: number | null): Promise<void> {
    const today = todayDay();
    try {
      const item = await api.createItem(laneId, {
        title: parentId ? "New child item" : "New item",
        description: "",
        startDate: isoOf(today),
        endDate: isoOf(today + 27),
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
      state.selectedItemId = item.id;
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
};
