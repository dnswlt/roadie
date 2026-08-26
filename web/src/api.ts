import type {
  Contributor,
  Dependency,
  DependencyRef,
  Item,
  ItemPatch,
  Lane,
  LanePatch,
  Me,
  Milestone,
  MilestonePatch,
  NewItem,
  NewMilestone,
  NewSchedulePeriod,
  Roadmap,
  RoadmapFull,
  SchedulePeriod,
  Snapshot,
  TrackerExtractor,
  TrackerExtractorTest,
  TrackerPage,
  TrackerQuery,
  TrackerScheduleStatus,
  TrashedRoadmap,
  Visibility,
} from "./types";

// clientId identifies this tab. It rides on every request as X-Client-Id so the
// server can echo it back in change events, letting this tab ignore the events
// its own edits cause (see events.ts).
export const clientId =
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Math.random());

// signingIn guards against a burst of parallel 401s each starting their own
// navigation; the first one wins and the rest just stop.
let signingIn = false;

// toLogin sends the browser into the OIDC flow, coming back to wherever we
// were. Reached when the session expired under us (the server answers XHR with
// 401 rather than a redirect, since a redirect to the provider would only show
// up as an opaque CORS failure). Never returns in practice — the promise it
// leaves pending is abandoned by the navigation.
export function toLogin(): void {
  if (signingIn) return;
  signingIn = true;
  const next = location.pathname + location.search + location.hash;
  location.assign(`/auth/login?next=${encodeURIComponent(next)}`);
}

// ApiError carries the status alongside the server's message, so a caller can
// tell one particular 404 — "nothing saved here yet", a state to render — from
// a failure. Everything else keeps treating it as the Error it extends.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "X-Client-Id": clientId };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    toLogin();
    throw new Error("not signed in");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      // keep statusText
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  me: () => req<Me>("GET", "/api/me"),
  logout: () => req<void>("POST", "/auth/logout"),

  listRoadmaps: () => req<Roadmap[]>("GET", "/api/roadmaps"),
  createRoadmap: (name: string, visibility: Visibility = "public") =>
    req<Roadmap>("POST", "/api/roadmaps", { name, visibility }),
  getRoadmap: (id: number) => req<RoadmapFull>("GET", `/api/roadmaps/${id}`),
  renameRoadmap: (id: number, name: string) =>
    req<Roadmap>("PATCH", `/api/roadmaps/${id}`, { name }),
  // Visibility is not roadmap content — it is not snapshotted and a restore
  // leaves it alone — so it has its own endpoint rather than riding in the
  // rename PATCH. Only the owner may call it; anyone else gets a 404.
  setVisibility: (id: number, visibility: Visibility) =>
    req<Roadmap>("PUT", `/api/roadmaps/${id}/visibility`, { visibility }),
  // Deleting a roadmap moves it to the trash; purging is the separate,
  // irreversible step.
  deleteRoadmap: (id: number) => req<void>("DELETE", `/api/roadmaps/${id}`),
  listTrash: () => req<TrashedRoadmap[]>("GET", "/api/roadmaps/trash"),
  restoreRoadmap: (id: number) =>
    req<Roadmap>("POST", `/api/roadmaps/${id}/restore`),
  purgeRoadmap: (id: number) =>
    req<void>("DELETE", `/api/roadmaps/${id}/purge`),
  exportRoadmapUrl: (id: number) => `/api/roadmaps/${id}/export`,
  // An import is always public; the server records the importer as its owner,
  // so it can be made private straight afterwards. The file's own visibility
  // field is ignored server-side — a file must not be able to publish itself.
  //
  // What happens to the identities in the file is the route, not a flag on one
  // (see ImportMode): importRoadmap always creates an independent roadmap,
  // transferRoadmap always keeps the file's UIDs and fails if any is already
  // there. The body is the exported file itself in both cases.
  importRoadmap: (data: unknown) =>
    req<Roadmap>("POST", "/api/roadmaps/import", data),
  transferRoadmap: (data: unknown) =>
    req<Roadmap>("POST", "/api/roadmaps/transfer", data),
  duplicateRoadmap: (id: number, name: string) =>
    req<Roadmap>("POST", `/api/roadmaps/${id}/duplicate`, { name }),

  searchTracker: (query: string, continuation?: string, pageSize?: number) =>
    req<TrackerPage>("POST", "/api/tracker/search", {
      query,
      continuation,
      pageSize,
    }),
  // Saved tracker queries: roadmap-scoped like lanes, but operational recon
  // data — separate routes, never part of the roadmap payload.
  listTrackerQueries: (roadmapId: number) =>
    req<TrackerQuery[]>("GET", `/api/roadmaps/${roadmapId}/tracker-queries`),
  createTrackerQuery: (roadmapId: number, name: string, query: string) =>
    req<TrackerQuery>("POST", `/api/roadmaps/${roadmapId}/tracker-queries`, {
      name,
      query,
    }),
  updateTrackerQuery: (id: number, patch: { name?: string; query?: string }) =>
    req<TrackerQuery>("PATCH", `/api/tracker-queries/${id}`, patch),
  deleteTrackerQuery: (id: number) =>
    req<void>("DELETE", `/api/tracker-queries/${id}`),

  // The schedule-check extractor script: one per roadmap, so the roadmap id is
  // its whole address and there is no create/update distinction to make.
  //
  // A roadmap with no script answers 404, which is a state the Recon tab
  // explains rather than an error — hence null instead of a throw. PUT
  // compiles the source server-side and rejects one that will not run, so its
  // failure message names a line in the editor.
  getTrackerExtractor: async (roadmapId: number) => {
    try {
      return await req<TrackerExtractor>(
        "GET",
        `/api/roadmaps/${roadmapId}/tracker-extractor`,
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  putTrackerExtractor: (roadmapId: number, source: string) =>
    req<TrackerExtractor>("PUT", `/api/roadmaps/${roadmapId}/tracker-extractor`, {
      source,
    }),
  deleteTrackerExtractor: (roadmapId: number) =>
    req<void>("DELETE", `/api/roadmaps/${roadmapId}/tracker-extractor`),
  // Test runs the editor's *unsaved* source against one issue: that is how a
  // script is arrived at, so it must work before Save would accept it. The
  // answer carries the tracker's raw JSON, which is the only way to find out
  // what a custom field is called in this deployment.
  testTrackerExtractor: (roadmapId: number, source: string, key: string) =>
    req<TrackerExtractorTest>(
      "POST",
      `/api/roadmaps/${roadmapId}/tracker-extractor/test`,
      { source, key },
    ),
  enqueueScheduleCheck: (roadmapId: number, keys: string[]) =>
    req<{ queued: number; pending: number }>(
      "POST",
      `/api/roadmaps/${roadmapId}/schedule-check`,
      { keys },
    ),
  getScheduleCheckStatus: (roadmapId: number, keys: string[]) =>
    req<TrackerScheduleStatus>(
      "POST",
      `/api/roadmaps/${roadmapId}/schedule-check/status`,
      { keys },
    ),

  listContributors: (roadmapId: number) =>
    req<Contributor[]>("GET", `/api/roadmaps/${roadmapId}/contributors`),
  listSnapshots: (roadmapId: number) =>
    req<Snapshot[]>("GET", `/api/roadmaps/${roadmapId}/snapshots`),
  createSnapshot: (roadmapId: number, name: string) =>
    req<Snapshot>("POST", `/api/roadmaps/${roadmapId}/snapshots`, { name }),
  getSnapshot: (id: number) => req<RoadmapFull>("GET", `/api/snapshots/${id}`),
  renameSnapshot: (id: number, name: string) =>
    req<Snapshot>("PATCH", `/api/snapshots/${id}`, { name }),
  restoreSnapshot: (id: number) =>
    req<Roadmap>("POST", `/api/snapshots/${id}/restore`),
  deleteSnapshot: (id: number) => req<void>("DELETE", `/api/snapshots/${id}`),

  createLane: (roadmapId: number, name: string) =>
    req<Lane>("POST", `/api/roadmaps/${roadmapId}/lanes`, { name }),
  setLaneOrder: (roadmapId: number, laneIds: number[]) =>
    req<void>("PUT", `/api/roadmaps/${roadmapId}/lane-order`, { laneIds }),
  updateLane: (id: number, patch: LanePatch) =>
    req<Lane>("PATCH", `/api/lanes/${id}`, patch),
  deleteLane: (id: number) => req<void>("DELETE", `/api/lanes/${id}`),

  createItem: (laneId: number, item: NewItem) =>
    req<Item>("POST", `/api/lanes/${laneId}/items`, item),
  updateItem: (id: number, patch: ItemPatch) =>
    req<Item>("PATCH", `/api/items/${id}`, patch),
  deleteItem: (id: number) => req<void>("DELETE", `/api/items/${id}`),

  createMilestone: (laneId: number, milestone: NewMilestone) =>
    req<Milestone>("POST", `/api/lanes/${laneId}/milestones`, milestone),
  updateMilestone: (id: number, patch: MilestonePatch) =>
    req<Milestone>("PATCH", `/api/milestones/${id}`, patch),
  deleteMilestone: (id: number) => req<void>("DELETE", `/api/milestones/${id}`),

  replaceSchedule: (roadmapId: number, periods: NewSchedulePeriod[]) =>
    req<SchedulePeriod[]>("PUT", `/api/roadmaps/${roadmapId}/schedule`, {
      periods,
    }),

  // Dependency reads ride in the RoadmapFull payload; only the two mutations
  // have endpoints. from = prerequisite, to = dependent ("to needs from").
  createDependency: (
    roadmapId: number,
    from: DependencyRef,
    to: DependencyRef,
  ) =>
    req<Dependency>("POST", `/api/roadmaps/${roadmapId}/dependencies`, {
      from,
      to,
    }),
  deleteDependency: (id: number) =>
    req<void>("DELETE", `/api/dependencies/${id}`),
};
