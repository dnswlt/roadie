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

type Roadmap struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Lane struct {
	ID        int64  `json:"id"`
	RoadmapID int64  `json:"roadmapId"`
	Name      string `json:"name"`
	Position  int    `json:"position"`
	Color     string `json:"color"`
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
	Priority    *int      `json:"priority"` // 1..4 (1 = highest); nil = unprioritized
	Labels      []string  `json:"labels"`   // free-form tags, shared across the roadmap
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
	ID          int64     `json:"id"`
	LaneID      int64     `json:"laneId"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Date        Date      `json:"date"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type LaneFull struct {
	Lane
	Items      []ItemFull  `json:"items"`
	Milestones []Milestone `json:"milestones"`
}

// RoadmapFull is the complete payload the frontend works with.
type RoadmapFull struct {
	Roadmap
	Lanes []LaneFull `json:"lanes"`
}

// Export format markers. The on-disk file is a small envelope around a
// RoadmapFull so imports can recognize the file and reject unrelated JSON.
// Bump ExportVersion only on incompatible changes to the payload shape.
const (
	ExportFormat  = "roadie.roadmap"
	ExportVersion = 1
)

// RoadmapExport is the download/upload envelope. On import the embedded
// roadmap's IDs and timestamps are ignored; the store assigns fresh ones and
// reconstructs the item hierarchy from the nesting, not from parentId.
type RoadmapExport struct {
	Format  string      `json:"format"`
	Version int         `json:"version"`
	Roadmap RoadmapFull `json:"roadmap"`
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
