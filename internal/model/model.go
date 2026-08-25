package model

import (
	"encoding/json"
	"fmt"
	"time"
)

const dateLayout = "2006-01-02"

// Date is a calendar day without a time zone, JSON-encoded as "2006-01-02".
type Date struct{ time.Time }

func NewDate(t time.Time) Date {
	return Date{time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)}
}

func ParseDate(s string) (Date, error) {
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		return Date{}, fmt.Errorf("invalid date %q (want YYYY-MM-DD)", s)
	}
	return Date{t}, nil
}

func (d Date) MarshalJSON() ([]byte, error) {
	return []byte(`"` + d.Format(dateLayout) + `"`), nil
}

func (d *Date) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	if len(b) < 2 || b[0] != '"' || b[len(b)-1] != '"' {
		return fmt.Errorf("invalid date %s (want \"YYYY-MM-DD\")", b)
	}
	parsed, err := ParseDate(string(b[1 : len(b)-1]))
	if err != nil {
		return err
	}
	*d = parsed
	return nil
}

// Opt is an optional JSON field: it distinguishes "absent" (Set == false)
// from "present", including an explicit null (Set == true, zero Value).
type Opt[T any] struct {
	Set   bool
	Value T
}

func (o *Opt[T]) UnmarshalJSON(b []byte) error {
	o.Set = true
	return json.Unmarshal(b, &o.Value)
}

// Roadmap visibility. Public roadmaps are readable and editable by everyone,
// including anonymous callers when the server runs with auth off — which is
// what every roadmap is in that mode. Private ones are reachable only by the
// subjects listed in roadmap_members.
//
// There is no read-only sharing: "public" means writable, exactly as Roadie
// behaved before visibility existed.
const (
	VisibilityPublic  = "public"
	VisibilityPrivate = "private"
)

type Roadmap struct {
	ID int64 `json:"id"`
	// UID is the roadmap's portable identity: stable across a restore and
	// carried through exports, so a transfer import can recognize the same
	// logical roadmap wherever the file turns up. It is assigned at creation and
	// never changes; the API returns it but no patch accepts it.
	//
	// Nothing resolves a cross-roadmap reference through it — a milestone UID is
	// globally unique on its own — so it exists purely to answer "is this same
	// roadmap already here", including for a roadmap with no milestones.
	UID       string    `json:"uid"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	// DeletedAt is when the roadmap was moved to the trash, nil while it is
	// live. It is set on every roadmap the client can see except the ones in
	// the trash listing, so it is omitted from the wire rather than sent as
	// null everywhere; the trash UI needs it to show how long a roadmap has
	// been there and when it will be purged.
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
	// Visibility is VisibilityPublic or VisibilityPrivate.
	//
	// It rides in RoadmapFull and therefore in the export envelope and every
	// snapshot blob, because Roadmap is embedded there — but it is *not*
	// roadmap content, and both ImportRoadmap and RestoreSnapshot ignore it for
	// the same reason they ignore the embedded IDs and timestamps. Restoring a
	// January snapshot must not republish what you made private in June, and
	// importing a file must not grant anybody access. Who may see a roadmap is
	// decided when it is created and by its owner afterwards, never by a
	// payload.
	Visibility string `json:"visibility"`
	// Owned reports whether the *requesting* user owns this roadmap, and hence
	// may change its visibility. It is derived per request, never stored and
	// never persisted: the subject it comes from is not sent to the client (as
	// with Contributor.Subject), so the client gets the decision rather than the
	// identity. Being derived, it is only set where the answer is known without
	// an extra query — the roadmap listings, the single-roadmap read, and the
	// three writes whose caller is the owner by construction (create, import,
	// set-visibility). Elsewhere (rename, restore) it stays false, which is
	// safe: the client reads it only from the listings and the single read.
	// `omitempty` keeps it out of export files and snapshot blobs entirely.
	//
	// Roadmaps created with auth off have no owner and nobody can claim one, so
	// this is false for everybody and they stay public forever.
	Owned bool `json:"owned,omitempty"`
}

type Lane struct {
	ID        int64     `json:"id"`
	RoadmapID int64     `json:"roadmapId"`
	Name      string    `json:"name"`
	Position  int       `json:"position"`
	Color     string    `json:"color"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Item struct {
	ID          int64     `json:"id"`
	LaneID      int64     `json:"laneId"`
	ParentID    *int64    `json:"parentId"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	StartDate   Date      `json:"startDate"`
	EndDate     Date      `json:"endDate"`
	Rank        int       `json:"rank"`
	Priority    *int      `json:"priority"`  // 1..4 (1 = highest); nil = unprioritized
	Labels      []string  `json:"labels"`    // free-form tags, shared across the roadmap
	Flagged     bool      `json:"flagged"`   // "needs attention" marker; meaning owned by the app
	Tentative   bool      `json:"tentative"` // timing is not a precise commitment
	AtRisk      bool      `json:"atRisk"`    // plan still intended, but materially in doubt
	UpdatedAt   time.Time `json:"updatedAt"`
}

// ItemFull is a top-level item together with its children.
type ItemFull struct {
	Item
	Children []Item `json:"children"`
}

// Milestone is a fixed date within a lane. Unlike items it has no duration
// and no rank; it is positioned purely by its date.
type Milestone struct {
	ID int64 `json:"id"`
	// UID is the milestone's portable identity, globally unique and immutable
	// from creation — the name anything outside this roadmap refers to it by,
	// where the database ID means nothing. Every milestone has one, because any
	// of them may be published later. Items and lanes have none.
	UID         string    `json:"uid"`
	LaneID      int64     `json:"laneId"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Date        Date      `json:"date"`
	Tentative   bool      `json:"tentative"` // timing is not a precise commitment
	UpdatedAt   time.Time `json:"updatedAt"`
}

type LaneFull struct {
	Lane
	Items      []ItemFull  `json:"items"`
	Milestones []Milestone `json:"milestones"`
}

// Dependency endpoint kinds.
const (
	DepItem      = "item"
	DepMilestone = "milestone"
)

// DependencyRef names one endpoint of a dependency edge: an item or a
// milestone, both always in the edge's own roadmap.
type DependencyRef struct {
	Kind string `json:"kind"` // DepItem or DepMilestone
	ID   int64  `json:"id"`
}

// Dependency is one directed edge in a roadmap's dependency graph: From is
// the prerequisite, To the dependent — "To needs From". An edge carries no
// attributes (no type, no lag, no label) on purpose: one edge kind, meaning
// owned by the product. The graph is roadmap-scoped and acyclic, enforced in
// internal/store.
type Dependency struct {
	ID   int64         `json:"id"`
	From DependencyRef `json:"from"`
	To   DependencyRef `json:"to"`
}

// SchedulePeriod is one named span in a roadmap's schedule (a sprint, PI, ...).
// It has an inclusive end date and, like milestones, no rank: periods are
// positioned purely by their dates. A period belongs to the roadmap, not a lane.
type SchedulePeriod struct {
	ID        int64  `json:"id"`
	Label     string `json:"label"`
	StartDate Date   `json:"startDate"`
	EndDate   Date   `json:"endDate"`
}

// RoadmapFull is the complete payload the frontend works with. Dependencies
// are a flat roadmap-level list rather than per-item adjacency arrays, so
// every edge is stated exactly once; views derive what they need from it.
type RoadmapFull struct {
	Roadmap
	Lanes        []LaneFull       `json:"lanes"`
	Periods      []SchedulePeriod `json:"periods"`
	Dependencies []Dependency     `json:"dependencies"`
}

// Export format markers. The on-disk file is a small envelope around a
// RoadmapFull so imports can recognize the file and reject unrelated JSON.
// Bump ExportVersion only on incompatible changes to the payload shape.
//
// Version 2 added the roadmap and milestone UIDs.
const (
	ExportFormat  = "roadie.roadmap"
	ExportVersion = 2
	// MinExportVersion is the oldest format an import accepts. Version 1 files
	// predate entity UIDs, and an import that had to invent identities for them
	// would need a third set of rules; they are deliberately not supported.
	MinExportVersion = 2
)

// RoadmapExport is the download/upload envelope. On import the embedded
// roadmap's database IDs and timestamps are ignored; the store assigns fresh
// ones and reconstructs the item hierarchy from the nesting, not from parentId.
// A file must carry a UID for the roadmap and for every milestone; the import
// mode decides whether they are kept or replaced, and the contents never decide
// it (see notes/stable_uids.md).
type RoadmapExport struct {
	Format  string      `json:"format"`
	Version int         `json:"version"`
	Roadmap RoadmapFull `json:"roadmap"`
}

// Contributor is one person who has edited a roadmap, with the window over
// which they did it. It answers "who worked on this roadmap" — deliberately a
// set of people rather than a per-change audit trail, and with no edit counter
// (see migrations/009_contributors.sql).
//
// Contributors are metadata about the editing history, not roadmap content, so
// they are absent from RoadmapFull and the export envelope: restoring an old
// snapshot must not rewrite who has worked on a roadmap. Name is denormalized
// at write time — there is no user table to join against — and reflects
// whatever the identity provider last reported. Subject is the OIDC subject,
// used as the row key but not exposed to the client, which only ever displays
// names.
type Contributor struct {
	Subject   string    `json:"-"`
	Name      string    `json:"name"`
	FirstSeen time.Time `json:"firstSeen"`
	LastSeen  time.Time `json:"lastSeen"`
}

// TrackerQuery is one saved tracker query (a reconciliation "favourite",
// notes/JIRA.md): a name plus the query text it stands for. Roadmap-scoped
// operational data, not roadmap content — never part of RoadmapFull, snapshots
// or exports. The query is provider syntax (JQL today) passed through opaquely.
type TrackerQuery struct {
	ID        int64  `json:"id"`
	RoadmapID int64  `json:"roadmapId"`
	Name      string `json:"name"`
	Query     string `json:"query"`
}

// Snapshot kinds. Auto snapshots are captured on a throttle and pruned; manual
// (named) snapshots are user-created and kept indefinitely.
const (
	SnapshotAuto   = "auto"
	SnapshotManual = "manual"
)

// Snapshot is the metadata for one stored version of a roadmap. The payload
// blob (a RoadmapExport) is deliberately not part of this struct: listings
// return metadata only, and the full contents are fetched separately.
type Snapshot struct {
	ID        int64     `json:"id"`
	RoadmapID int64     `json:"roadmapId"`
	Name      *string   `json:"name"` // null for unnamed/auto snapshots
	Kind      string    `json:"kind"`
	CreatedAt time.Time `json:"createdAt"`
}
