// Mirrors the JSON payloads of the Go backend (internal/model).

// Who can reach a roadmap. "public" means everyone, and everyone may edit it —
// there is no read-only sharing. "private" means only its members, which for
// now is just whoever created it.
export type Visibility = "private" | "public";

export interface Roadmap {
  id: number;
  name: string;
  // The server also sends updatedAt, deliberately not declared here: it only
  // moves when the roadmaps row itself is written (rename, restore), so it is
  // not the "last edited" it looks like. Contributors answer that instead.
  createdAt: string; // ISO 8601 timestamp
  visibility: Visibility;
  // owned means *you* own this roadmap and may therefore change its visibility.
  // Derived by the server per request from the caller's identity, and omitted
  // when false — including for every roadmap when auth is off, where nobody
  // owns anything. Roadmaps created before visibility existed, or created with
  // auth off, have no owner at all and stay public forever.
  owned?: boolean;
}

// TrashedRoadmap is a roadmap in the trash, as returned by GET
// /api/roadmaps/trash. purgeAt is computed by the server from its retention
// policy rather than duplicated here, so the countdown the UI shows can't drift
// from the sweeper that actually does the deleting.
export interface TrashedRoadmap extends Roadmap {
  deletedAt: string;
  purgeAt: string;
}

export interface Lane {
  id: number;
  roadmapId: number;
  name: string;
  position: number;
  color: string;
}

export interface LanePatch {
  name?: string;
  color?: string;
}

export interface Item {
  id: number;
  laneId: number;
  parentId: number | null;
  title: string;
  description: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  rank: number; // position within the container (lane / parent), dense 0..n-1
  priority: number | null; // 1..4 (1 = highest); null = unprioritized
  labels: string[]; // free-form tags, shared across the roadmap
  flagged: boolean; // "needs attention" marker; its meaning is the app's, not the user's
}

export interface ItemFull extends Item {
  children: Item[];
}

export interface Milestone {
  id: number;
  laneId: number;
  title: string;
  description: string;
  date: string; // YYYY-MM-DD
}

export interface LaneFull extends Lane {
  items: ItemFull[];
  milestones: Milestone[];
}

// A named span in a roadmap's schedule (a sprint, PI, ...). endDate is
// inclusive. Periods are roadmap-scoped and ordered by start date, no rank.
export interface SchedulePeriod {
  id: number;
  label: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD, inclusive
}

// NewSchedulePeriod is one period sent to the server on a full-schedule
// replace; the server assigns ids.
export interface NewSchedulePeriod {
  label: string;
  startDate: string;
  endDate: string;
}

export interface RoadmapFull extends Roadmap {
  lanes: LaneFull[];
  periods: SchedulePeriod[];
}

// One person who has edited a roadmap, shown above the version-history list.
// This is editing metadata rather than roadmap content, which is why it is
// fetched on its own instead of riding in RoadmapFull — that payload is also
// what snapshots serialize, and viewing an old version must not show an old
// author list. The server sends no user id: only names are ever displayed.
export interface Contributor {
  name: string;
  firstSeen: string; // ISO 8601 timestamp
  lastSeen: string; // ISO 8601 timestamp
}

// Snapshot metadata (no payload) for the version-history list. `name` is set
// only for manual/named snapshots; auto snapshots have a null name.
export interface Snapshot {
  id: number;
  roadmapId: number;
  name: string | null;
  kind: "auto" | "manual";
  createdAt: string; // ISO 8601 timestamp
}

// Partial update for PATCH /api/items/{id}. parentId: null explicitly
// detaches an item from its parent.
export interface ItemPatch {
  title?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  laneId?: number;
  parentId?: number | null;
  rank?: number;
  priority?: number | null;
  labels?: string[];
  flagged?: boolean;
}

export interface NewItem {
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  parentId?: number | null;
  rank?: number; // slot within the container, clamped server-side; omitted = append
}

export interface NewMilestone {
  title: string;
  description: string;
  date: string;
}

export interface MilestonePatch {
  title?: string;
  description?: string;
  date?: string;
}

// Me mirrors the server's /api/me response. mode tells the UI whether this
// deployment authenticates at all: with "open" there is no account concept and
// no sign-in affordance is shown. Reaching the app at all with mode "oidc"
// implies authenticated, since the server gates every route.
export interface Me {
  mode: "open" | "oidc";
  authenticated: boolean;
  name?: string;
  email?: string;
}
