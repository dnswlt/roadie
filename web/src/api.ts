import type { Item, ItemPatch, Lane, NewItem, Roadmap, RoadmapFull } from "./types";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      // keep statusText
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  listRoadmaps: () => req<Roadmap[]>("GET", "/api/roadmaps"),
  createRoadmap: (name: string) => req<Roadmap>("POST", "/api/roadmaps", { name }),
  getRoadmap: (id: number) => req<RoadmapFull>("GET", `/api/roadmaps/${id}`),
  renameRoadmap: (id: number, name: string) => req<Roadmap>("PATCH", `/api/roadmaps/${id}`, { name }),
  deleteRoadmap: (id: number) => req<void>("DELETE", `/api/roadmaps/${id}`),

  createLane: (roadmapId: number, name: string) =>
    req<Lane>("POST", `/api/roadmaps/${roadmapId}/lanes`, { name }),
  setLaneOrder: (roadmapId: number, laneIds: number[]) =>
    req<void>("PUT", `/api/roadmaps/${roadmapId}/lane-order`, { laneIds }),
  renameLane: (id: number, name: string) => req<Lane>("PATCH", `/api/lanes/${id}`, { name }),
  deleteLane: (id: number) => req<void>("DELETE", `/api/lanes/${id}`),

  createItem: (laneId: number, item: NewItem) => req<Item>("POST", `/api/lanes/${laneId}/items`, item),
  updateItem: (id: number, patch: ItemPatch) => req<Item>("PATCH", `/api/items/${id}`, patch),
  deleteItem: (id: number) => req<void>("DELETE", `/api/items/${id}`),
};
