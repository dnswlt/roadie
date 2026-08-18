// API helpers for the e2e gesture tests. Everything here talks to the same
// JSON API the app uses — with auth off that is plain fetch, a deliberate
// product property (CLAUDE.md). Tests seed their own uniquely named roadmap
// and purge it afterwards, so they are safe to run against a live `make dev`
// server: no pre-existing row is ever read or written.

import { expect, type APIRequestContext } from "@playwright/test";

export interface Seeded {
  roadmapId: number;
  laneId: number;
  items: { id: number; title: string }[]; // top-level, in rank order
}

// ItemNode is the slice of the server's item payload the tests assert on.
export interface ItemNode {
  id: number;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  rank: number;
  parentId: number | null;
  laneId: number;
  children: ItemNode[];
}

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data });
  expect(res.ok(), `POST ${url} -> ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

// seedRoadmap creates a fresh roadmap with one lane holding the given
// top-level items. The default dates are arbitrary but valid: WBS gestures
// never read them. Timeline tests may supply dates suited to their geometry.
export async function seedRoadmap(
  request: APIRequestContext,
  titles: string[],
  dates: { startDate: string; endDate: string } = {
    startDate: "2026-01-05",
    endDate: "2026-02-01",
  },
): Promise<Seeded> {
  const rm = await post<{ id: number }>(request, "/api/roadmaps", {
    name: `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    visibility: "public",
  });
  const lane = await post<{ id: number }>(request, `/api/roadmaps/${rm.id}/lanes`, { name: "Lane" });
  const items: Seeded["items"] = [];
  for (const title of titles) {
    items.push(
      await post<ItemNode>(request, `/api/lanes/${lane.id}/items`, {
        title,
        description: "",
        startDate: dates.startDate,
        endDate: dates.endDate,
        parentId: null,
      }),
    );
  }
  return { roadmapId: rm.id, laneId: lane.id, items };
}

// addLane extends a seeded roadmap when a gesture needs a structural target.
// It returns only the server id: tests still inspect resulting content through
// laneItems rather than through the DOM.
export async function addLane(
  request: APIRequestContext,
  roadmapId: number,
  name: string,
): Promise<number> {
  const lane = await post<{ id: number }>(request, `/api/roadmaps/${roadmapId}/lanes`, { name });
  return lane.id;
}

// markFlagged gives gesture specs a filter result without using the panel —
// filtering is arrangement for those tests; the pointer path is the act.
export async function markFlagged(
  request: APIRequestContext,
  itemId: number,
): Promise<void> {
  const res = await request.patch(`/api/items/${itemId}`, { data: { flagged: true } });
  expect(res.ok(), `PATCH item flag -> ${res.status()}`).toBe(true);
}

// addItemDependency creates the one graph edge kind: `to` needs `from`.
// Dependency-filter specs arrange edges through the API because the filter,
// not the panel picker, is the interaction under test.
export async function addItemDependency(
  request: APIRequestContext,
  roadmapId: number,
  fromId: number,
  toId: number,
): Promise<void> {
  await post(request, `/api/roadmaps/${roadmapId}/dependencies`, {
    from: { kind: "item", id: fromId },
    to: { kind: "item", id: toId },
  });
}

// addItem appends one item to a lane seedRoadmap did not fill, or nests one
// under parentId. Children are the structural case the filter treats specially
// (a matching child keeps its parent on screen as a breadcrumb), and a second
// lane is how a spec reaches a context it can hide.
export async function addItem(
  request: APIRequestContext,
  laneId: number,
  title: string,
  parentId: number | null = null,
): Promise<number> {
  const item = await post<{ id: number }>(request, `/api/lanes/${laneId}/items`, {
    title,
    description: "",
    startDate: "2026-01-05",
    endDate: "2026-02-01",
    parentId,
  });
  return item.id;
}

// setItemDates repositions a seeded item. Snapping specs use it to place one
// bar's edge a known number of pixels from another's, which is the whole
// arrangement a magnet test needs.
export async function setItemDates(
  request: APIRequestContext,
  itemId: number,
  startDate: string,
  endDate: string,
): Promise<void> {
  const res = await request.patch(`/api/items/${itemId}`, { data: { startDate, endDate } });
  expect(res.ok(), `PATCH item dates -> ${res.status()}`).toBe(true);
}

// setSchedule gives a seeded roadmap a schedule. PUT replaces the whole thing,
// which is also how the app's editor saves it.
export async function setSchedule(
  request: APIRequestContext,
  roadmapId: number,
  periods: { label: string; startDate: string; endDate: string }[],
): Promise<void> {
  const res = await request.put(`/api/roadmaps/${roadmapId}/schedule`, { data: { periods } });
  expect(res.ok(), `PUT schedule -> ${res.status()}`).toBe(true);
}

// addMilestone returns only the id; its date is read back through laneMilestones.
export async function addMilestone(
  request: APIRequestContext,
  laneId: number,
  title: string,
  date: string,
): Promise<number> {
  const ms = await post<{ id: number }>(request, `/api/lanes/${laneId}/milestones`, {
    title,
    description: "",
    date,
  });
  return ms.id;
}

// laneMilestones is laneItems for the lane's milestones.
export async function laneMilestones(
  request: APIRequestContext,
  roadmapId: number,
  laneId: number,
): Promise<{ id: number; date: string }[]> {
  const res = await request.get(`/api/roadmaps/${roadmapId}`);
  expect(res.ok(), `GET roadmap -> ${res.status()}`).toBe(true);
  const rm = (await res.json()) as {
    lanes: { id: number; milestones: { id: number; date: string }[] }[];
  };
  const lane = rm.lanes.find((l) => l.id === laneId);
  expect(lane, `lane ${laneId} exists`).toBeTruthy();
  return lane!.milestones;
}

// laneItems returns the lane's top-level items as the server sees them — the
// oracle every test asserts against.
export async function laneItems(
  request: APIRequestContext,
  roadmapId: number,
  laneId: number,
): Promise<ItemNode[]> {
  const res = await request.get(`/api/roadmaps/${roadmapId}`);
  expect(res.ok(), `GET roadmap -> ${res.status()}`).toBe(true);
  const rm = (await res.json()) as { lanes: { id: number; items: ItemNode[] }[] };
  const lane = rm.lanes.find((l) => l.id === laneId);
  expect(lane, `lane ${laneId} exists`).toBeTruthy();
  return lane!.items;
}

// purgeRoadmap deletes the throwaway roadmap for real: DELETE is a soft
// delete into the trash, purge is the irreversible second step (the store
// refuses to purge anything not already trashed).
export async function purgeRoadmap(request: APIRequestContext, roadmapId: number): Promise<void> {
  await request.delete(`/api/roadmaps/${roadmapId}`);
  await request.delete(`/api/roadmaps/${roadmapId}/purge`);
}
