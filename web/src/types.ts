// Mirrors the JSON payloads of the Go backend (internal/model).

// Who can reach a roadmap. "public" means everyone, and everyone may edit it —
// there is no read-only sharing. "private" means only its members, which for
// now is just whoever created it.
export type Visibility = "private" | "public";

export interface Roadmap {
  id: number;
  // The roadmap's portable identity: what it is called beyond the database it
  // lives in, so a transfer import can recognize the same logical roadmap in a
  // file. Nothing in the client resolves anything through it — links,
  // selections and view preferences all use the database id, which is stable
  // across a restore. It is here because it rides in every roadmap payload,
  // including exported files.
  uid: string;
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

// What an import does with the identities the file carries, and hence which
// endpoint it posts to. "copy" creates an independent roadmap, generating a new
// UID for it and for every milestone; "transfer" brings in the roadmap the file
// names, keeping them, and is refused outright if any of them is already there.
// The user picks; nothing infers the mode from what the file happens to collide
// with.
//
// There is no import-over-existing mode: version history is how an existing
// roadmap is put back.
export type ImportMode = "copy" | "transfer";

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
  tentative: boolean; // timing is not a precise commitment; sawtooth bar ends, "≈" in the WBS
  atRisk: boolean; // plan still intended, but materially in doubt; a warning chip
}

export interface ItemFull extends Item {
  children: Item[];
}

export interface MirrorSource {
  roadmapId?: number;
  roadmapName?: string;
  milestoneId?: number;
  title?: string;
}

export interface MirrorConsumer {
  roadmapId: number;
  roadmapName: string;
  milestoneId: number;
  title: string;
}

export interface MilestoneLinkage {
  integration: boolean;
  sourceUid?: string;
  source?: MirrorSource;
  consumers?: MirrorConsumer[];
  usedBy?: number;
}

// One source offered to a roadmap by the integration-milestone search endpoint.
export interface IntegrationMilestone {
  uid: string;
  title: string;
  description: string;
  date: string;
  tentative: boolean;
  roadmapId: number;
  roadmapName: string;
}

export interface Milestone {
  id: number;
  // Globally unique and immutable from creation: the name anything outside this
  // roadmap refers to the milestone by, where the database id means nothing.
  // Items and lanes have none — nothing outside a roadmap ever names one.
  uid: string;
  laneId: number;
  title: string;
  description: string;
  date: string; // YYYY-MM-DD
  tentative: boolean; // timing is not a precise commitment; hollow diamond in timeline/WBS
  linkage?: MilestoneLinkage;
}

export interface LaneFull extends Lane {
  items: ItemFull[];
  milestones: Milestone[];
}

// One endpoint of a dependency edge: an item or a milestone, always in the
// edge's own roadmap. The two kinds share the graph but not an id space.
export interface DependencyRef {
  kind: "item" | "milestone";
  id: number;
}

// One directed dependency edge: `from` is the prerequisite, `to` the dependent
// — "to needs from". An edge carries no attributes (no type, no lag, no label)
// by design: one edge kind, meaning owned by the product. The graph is
// roadmap-scoped and acyclic; the server rejects violations with a message
// naming the conflicting chain.
export interface Dependency {
  id: number;
  from: DependencyRef;
  to: DependencyRef;
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
  // A flat roadmap-level edge list, like periods: every edge is stated once,
  // and views derive per-entity adjacency from it (see deps-graph.ts).
  dependencies: Dependency[];
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

export interface TrackerIssue {
  id: string;
  key: string;
  title: string;
  type: string;
  status: string;
  url: string;
}

export interface TrackerPage {
  issues: TrackerIssue[];
  next?: string;
}

// One saved tracker query (a reconciliation "favourite"): a name plus the
// query text it stands for. Roadmap-scoped operational data, not roadmap
// content — never in RoadmapFull, snapshots or exports.
export interface TrackerQuery {
  id: number;
  roadmapId: number;
  name: string;
  query: string;
}

// A roadmap's schedule-extractor script (notes/schedule_check.md): the
// Starlark that says which Jira fields carry an issue's schedule. Operational
// recon data like TrackerQuery — never in RoadmapFull, snapshots or exports —
// and at most one per roadmap, so the roadmap is its whole identity.
export interface TrackerExtractor {
  roadmapId: number;
  source: string;
  updatedAt: string; // ISO 8601 timestamp
}

// The states one checked issue can be in, as internal/recon names them.
export type TrackerScheduleState = "ok" | "skipped" | "notFound" | "error";
export type TrackerScheduleErrorKind = "script" | "tracker";

// One cached schedule-check answer. Period references remain unresolved here:
// the frontend owns the roadmap schedule and the item/issue comparison.
interface TrackerScheduleResultBase {
  key: string;
  issue?: TrackerIssue;
  checkedAt?: string;
}

interface TrackerScheduleOKResult extends TrackerScheduleResultBase {
  state: "ok";
  start?: string;
  end?: string;
  startPeriod?: string;
  endPeriod?: string;
  label?: string;
}

interface TrackerScheduleErrorResult extends TrackerScheduleResultBase {
  state: "error";
  error: string;
  errorKind: TrackerScheduleErrorKind;
}

interface TrackerScheduleEmptyResult extends TrackerScheduleResultBase {
  state: "skipped" | "notFound" | "unchecked";
}

export type TrackerScheduleResult =
  | TrackerScheduleOKResult
  | TrackerScheduleErrorResult
  | TrackerScheduleEmptyResult;

export interface TrackerScheduleStatus {
  results: TrackerScheduleResult[];
  pending: number;
}

// One issue put through one script, the answer to the editor's Test.
//
// `raw` is the tracker's own JSON, nested and named as Jira names it — the
// script's argument verbatim, and the only provider-shaped payload the
// frontend ever receives. It is rendered by the Test panel and goes no
// further: never into AppState, an item, or anything that is persisted.
export interface TrackerExtractorTest {
  state: TrackerScheduleState;
  issue?: TrackerIssue;
  // What the script declared in JIRA_FIELDS. Empty explains a `raw` holding
  // nothing but the display fields.
  fields: string[];
  raw?: unknown;
  start?: string;
  end?: string;
  startPeriod?: string;
  endPeriod?: string;
  label?: string;
  error?: string;
  output?: string[];
  // JIRA_PROJECTS does not cover this key. The Test panel runs the extractor
  // anyway; the check would not have fetched the issue.
  outOfScope?: boolean;
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
  tentative?: boolean;
  atRisk?: boolean;
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
  tentative?: boolean;
}

export interface NewMirror {
  sourceUid: string;
  title?: string;
  description?: string;
}

export interface MilestonePatch {
  title?: string;
  description?: string;
  date?: string;
  tentative?: boolean;
  integration?: boolean;
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
  // The tracker deployment's base URL, empty when none is configured — the
  // presence of the URL is what "a tracker is configured" means. It is also
  // what decides whether a link in a description is a tracker issue link
  // (recon-diff.ts); read it through state.trackerUrl.
  trackerUrl: string;
}
