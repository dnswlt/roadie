package store

import (
	"context"
	"errors"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

func TestContributorsRecordAndList(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)

	if list, err := testStore.ListContributors(ctx, rm.ID); err != nil {
		t.Fatal(err)
	} else if len(list) != 0 {
		t.Fatalf("fresh roadmap: want no contributors, got %+v", list)
	}

	// Recorded out of alphabetical order, and "zoe" edits twice.
	for _, c := range []struct{ subject, name string }{
		{"sub-z", "Zoe"}, {"sub-a", "adam"}, {"sub-z", "Zoe"},
	} {
		if err := testStore.RecordContributor(ctx, rm.ID, c.subject, c.name); err != nil {
			t.Fatal(err)
		}
	}

	list, err := testStore.ListContributors(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	// One row per person however often they edit, ordered case-insensitively by
	// name (not by when or how much they edited — the list is a set, not a rank).
	if len(list) != 2 {
		t.Fatalf("want 2 contributors, got %+v", list)
	}
	if list[0].Name != "adam" || list[1].Name != "Zoe" {
		t.Fatalf("want [adam Zoe] in case-insensitive name order, got %q, %q", list[0].Name, list[1].Name)
	}
	for _, c := range list {
		if c.FirstSeen.IsZero() || c.LastSeen.IsZero() {
			t.Fatalf("contributor %q: timestamps not populated: %+v", c.Name, c)
		}
	}
}

// A repeat edit must move last_seen forward while leaving first_seen alone, and
// must pick up a display name the identity provider has since changed: the name
// is denormalized here, so this write is the only chance to refresh it.
func TestContributorRepeatEditKeepsFirstSeen(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)

	if err := testStore.RecordContributor(ctx, rm.ID, "sub-1", "Old Name"); err != nil {
		t.Fatal(err)
	}
	first, err := testStore.ListContributors(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}

	if err := testStore.RecordContributor(ctx, rm.ID, "sub-1", "New Name"); err != nil {
		t.Fatal(err)
	}
	second, err := testStore.ListContributors(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}

	if len(second) != 1 {
		t.Fatalf("want 1 contributor after a repeat edit, got %+v", second)
	}
	if got := second[0].Name; got != "New Name" {
		t.Fatalf("display name not refreshed: want %q, got %q", "New Name", got)
	}
	if !second[0].FirstSeen.Equal(first[0].FirstSeen) {
		t.Fatalf("first_seen moved: was %v, now %v", first[0].FirstSeen, second[0].FirstSeen)
	}
	if second[0].LastSeen.Before(first[0].LastSeen) {
		t.Fatalf("last_seen went backwards: was %v, now %v", first[0].LastSeen, second[0].LastSeen)
	}
}

// Contributors record who has edited a roadmap, not what the roadmap contains,
// so a restore must leave them alone — otherwise going back to an old version
// would erase everyone who has worked on it since. This is the opposite of how
// RestoreSnapshot treats schedule_periods, the other roadmap-scoped table.
func TestContributorsSurviveSnapshotRestore(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	seedSmallRoadmap(t, rm.ID)

	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotAuto, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Someone edits *after* the snapshot was taken; restoring must not un-person
	// them, even though none of their work survives the restore.
	if err := testStore.RecordContributor(ctx, rm.ID, "sub-late", "Late Editor"); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.RestoreSnapshot(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}

	list, err := testStore.ListContributors(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Name != "Late Editor" {
		t.Fatalf("contributors did not survive restore: %+v", list)
	}
}

func TestContributorsUnknownRoadmap(t *testing.T) {
	if _, err := testStore.ListContributors(context.Background(), 999999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}
