package store

import (
	"context"
	"errors"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

func TestTrackerExtractorCRUD(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)

	// No script is a state the Recon tab explains, so it reads as ErrNotFound
	// rather than an empty script.
	if _, err := testStore.GetTrackerExtractor(ctx, rm.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get before put = %v", err)
	}

	src := "def get_issue_time_range(issue):\n    return None\n"
	e, err := testStore.PutTrackerExtractor(ctx, rm.ID, src)
	if err != nil {
		t.Fatal(err)
	}
	if e.RoadmapID != rm.ID || e.Source != src || e.UpdatedAt.IsZero() {
		t.Fatalf("put = %+v", e)
	}

	// The roadmap is the identity: a second put replaces, never adds.
	src2 := "JIRA_FIELDS = [\"duedate\"]\n" + src
	e2, err := testStore.PutTrackerExtractor(ctx, rm.ID, src2)
	if err != nil {
		t.Fatal(err)
	}
	if e2.Source != src2 || !e2.UpdatedAt.After(e.UpdatedAt) {
		t.Fatalf("replace = %+v (was %+v)", e2, e)
	}
	got, err := testStore.GetTrackerExtractor(ctx, rm.ID)
	if err != nil || got.Source != src2 {
		t.Fatalf("get = %+v, %v", got, err)
	}

	if err := testStore.DeleteTrackerExtractor(ctx, rm.ID); err != nil {
		t.Fatal(err)
	}
	if err := testStore.DeleteTrackerExtractor(ctx, rm.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v", err)
	}
}

// The script is operational config, not roadmap content: it cascades with the
// roadmap and a snapshot restore never brings an old one back.
func TestTrackerExtractorIsNotRoadmapContent(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	if _, err := testStore.PutTrackerExtractor(ctx, rm.ID, "def get_issue_time_range(issue):\n    return None\n"); err != nil {
		t.Fatal(err)
	}
	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotAuto, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := testStore.DeleteTrackerExtractor(ctx, rm.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.RestoreSnapshot(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.GetTrackerExtractor(ctx, rm.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("restore resurrected the script: %v", err)
	}
}
