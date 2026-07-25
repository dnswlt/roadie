package store

import (
	"context"
	"strconv"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

func TestReplaceScheduleRoundTrip(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)

	in := []SchedulePeriodInput{
		// Deliberately out of order: the store sorts by start date.
		{Label: "Sprint 2", StartDate: date("2026-01-19"), EndDate: date("2026-01-30")},
		{Label: "Sprint 1", StartDate: date("2026-01-05"), EndDate: date("2026-01-16")},
	}
	got, err := testStore.ReplaceSchedule(ctx, rm.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Label != "Sprint 1" || got[1].Label != "Sprint 2" {
		t.Fatalf("got %+v, want [Sprint 1, Sprint 2] ordered by start date", got)
	}

	// The schedule comes back with the full roadmap.
	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Periods) != 2 || full.Periods[0].Label != "Sprint 1" {
		t.Fatalf("GetRoadmapFull periods = %+v", full.Periods)
	}

	// Replacing is a full swap; an empty list clears the schedule.
	if _, err := testStore.ReplaceSchedule(ctx, rm.ID, nil); err != nil {
		t.Fatal(err)
	}
	full, err = testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Periods) != 0 {
		t.Fatalf("expected cleared schedule, got %+v", full.Periods)
	}
}

func TestReplaceScheduleValidation(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)

	cases := map[string][]SchedulePeriodInput{
		"empty label": {{Label: "  ", StartDate: date("2026-01-05"), EndDate: date("2026-01-16")}},
		"end before start": {{Label: "Bad", StartDate: date("2026-01-16"), EndDate: date("2026-01-05")}},
		"overlap": {
			{Label: "A", StartDate: date("2026-01-05"), EndDate: date("2026-01-20")},
			{Label: "B", StartDate: date("2026-01-16"), EndDate: date("2026-01-30")},
		},
		"touching boundaries overlap": {
			// A ends 01-16 inclusive; B starts 01-16 -> they share that day.
			{Label: "A", StartDate: date("2026-01-05"), EndDate: date("2026-01-16")},
			{Label: "B", StartDate: date("2026-01-16"), EndDate: date("2026-01-30")},
		},
	}
	for name, in := range cases {
		if _, err := testStore.ReplaceSchedule(ctx, rm.ID, in); !isValidation(err) {
			t.Errorf("%s: expected validation error, got %v", name, err)
		}
	}

	// Adjacent (gap of one day) is fine.
	if _, err := testStore.ReplaceSchedule(ctx, rm.ID, []SchedulePeriodInput{
		{Label: "A", StartDate: date("2026-01-05"), EndDate: date("2026-01-16")},
		{Label: "B", StartDate: date("2026-01-17"), EndDate: date("2026-01-30")},
	}); err != nil {
		t.Errorf("adjacent periods should be valid: %v", err)
	}

	if _, err := testStore.ReplaceSchedule(ctx, int64(0), nil); err != ErrNotFound {
		t.Errorf("expected ErrNotFound for missing roadmap, got %v", err)
	}
}

// A snapshot captured before the schedule feature has no "periods" key in its
// stored JSON; GetSnapshotContents must still hand the client a present (empty)
// slice, not nil, or the read-only preview render would crash.
func TestGetSnapshotContentsNormalizesLegacyPeriods(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)

	legacy := []byte(`{"format":"roadie.roadmap","version":1,"roadmap":{"id":` +
		strconv.FormatInt(rm.ID, 10) + `,"name":"legacy","lanes":[]}}`)
	var snapID int64
	if err := testStore.pool.QueryRow(ctx,
		`INSERT INTO snapshots (roadmap_id, kind, format_version, data)
		 VALUES ($1, 'auto', 1, $2) RETURNING id`, rm.ID, legacy).Scan(&snapID); err != nil {
		t.Fatal(err)
	}

	full, err := testStore.GetSnapshotContents(ctx, snapID)
	if err != nil {
		t.Fatal(err)
	}
	if full.Periods == nil {
		t.Fatal("Periods is nil, want [] from a legacy snapshot blob")
	}
	if len(full.Periods) != 0 {
		t.Fatalf("Periods = %+v, want empty", full.Periods)
	}
}

func TestScheduleSurvivesSnapshotRestore(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	if _, err := testStore.ReplaceSchedule(ctx, rm.ID, []SchedulePeriodInput{
		{Label: "PI 2026-Q1", StartDate: date("2026-01-05"), EndDate: date("2026-03-27")},
	}); err != nil {
		t.Fatal(err)
	}
	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotAuto, nil)
	if err != nil {
		t.Fatal(err)
	}

	// Change the schedule, then restore: the snapshot's schedule should be back.
	if _, err := testStore.ReplaceSchedule(ctx, rm.ID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.RestoreSnapshot(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Periods) != 1 || full.Periods[0].Label != "PI 2026-Q1" {
		t.Fatalf("restored schedule = %+v, want [PI 2026-Q1]", full.Periods)
	}
}
