package store

import (
	"context"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

// seedSmallRoadmap fills rm with one lane, a parent+child item, and a
// milestone, returning the lane for follow-up mutations.
func seedSmallRoadmap(t *testing.T, rmID int64) model.Lane {
	t.Helper()
	ctx := context.Background()
	lane, err := testStore.CreateLane(ctx, rmID, "L1")
	if err != nil {
		t.Fatal(err)
	}
	parent, err := testStore.CreateItem(ctx, lane.ID, NewItem{
		Title: "Parent", StartDate: date("2026-01-01"), EndDate: date("2026-02-01")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateItem(ctx, lane.ID, NewItem{
		Title: "Child", StartDate: date("2026-01-05"), EndDate: date("2026-01-10"), ParentID: &parent.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{
		Title: "Launch", Date: date("2026-03-01")}); err != nil {
		t.Fatal(err)
	}
	return lane
}

func TestSnapshotCreateListGet(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	seedSmallRoadmap(t, rm.ID)

	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotAuto, nil)
	if err != nil {
		t.Fatal(err)
	}
	if snap.ID == 0 || snap.RoadmapID != rm.ID || snap.Kind != model.SnapshotAuto || snap.Name != nil {
		t.Fatalf("unexpected snapshot metadata: %+v", snap)
	}

	list, err := testStore.ListSnapshots(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != snap.ID {
		t.Fatalf("list: want [%d], got %+v", snap.ID, list)
	}

	full, err := testStore.GetSnapshotContents(ctx, snap.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Lanes) != 1 || len(full.Lanes[0].Items) != 1 ||
		len(full.Lanes[0].Items[0].Children) != 1 || len(full.Lanes[0].Milestones) != 1 {
		t.Fatalf("snapshot contents not preserved: %+v", full)
	}

	if _, err := testStore.CreateSnapshot(ctx, 0, model.SnapshotAuto, nil); err != ErrNotFound {
		t.Errorf("snapshot of missing roadmap: want ErrNotFound, got %v", err)
	}
	if _, err := testStore.CreateSnapshot(ctx, rm.ID, "bogus", nil); !isValidation(err) {
		t.Errorf("bad kind: want validation error, got %v", err)
	}
	if _, err := testStore.GetSnapshotContents(ctx, 0); err != ErrNotFound {
		t.Errorf("missing snapshot: want ErrNotFound, got %v", err)
	}
	if _, err := testStore.ListSnapshots(ctx, 0); err != ErrNotFound {
		t.Errorf("list of missing roadmap: want ErrNotFound, got %v", err)
	}
}

func TestSnapshotRestore(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane := seedSmallRoadmap(t, rm.ID)

	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotAuto, nil)
	if err != nil {
		t.Fatal(err)
	}

	// Diverge from the snapshot: add a lane and an item.
	lane2, err := testStore.CreateLane(ctx, rm.ID, "L2")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateItem(ctx, lane2.ID, NewItem{
		Title: "Later", StartDate: date("2026-04-01"), EndDate: date("2026-04-10")}); err != nil {
		t.Fatal(err)
	}

	restored, err := testStore.RestoreSnapshot(ctx, snap.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Same roadmap identity is kept.
	if restored.ID != rm.ID || restored.Name != rm.Name {
		t.Errorf("restore changed roadmap identity: %+v", restored)
	}

	got, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Lanes) != 1 || got.Lanes[0].Name != "L1" {
		t.Fatalf("restore did not replace contents: %d lanes", len(got.Lanes))
	}
	if got.Lanes[0].ID == lane.ID {
		t.Errorf("restore should reinsert with fresh IDs, reused lane ID %d", lane.ID)
	}
	if n := len(got.Lanes[0].Items); n != 1 {
		t.Fatalf("items after restore: want 1, got %d", n)
	}

	// Restore captured the pre-restore state as an extra auto snapshot.
	list, err := testStore.ListSnapshots(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("snapshots after restore: want 2 (original + pre-restore), got %d", len(list))
	}
}

func TestSnapshotRenamePromotesToManual(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	seedSmallRoadmap(t, rm.ID)

	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotAuto, nil)
	if err != nil {
		t.Fatal(err)
	}
	renamed, err := testStore.RenameSnapshot(ctx, snap.ID, "Before the big refactor")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Kind != model.SnapshotManual || renamed.Name == nil || *renamed.Name != "Before the big refactor" {
		t.Fatalf("rename did not name+promote: %+v", renamed)
	}
	if _, err := testStore.RenameSnapshot(ctx, snap.ID, ""); !isValidation(err) {
		t.Errorf("empty name: want validation error, got %v", err)
	}
	if _, err := testStore.RenameSnapshot(ctx, 0, "x"); err != ErrNotFound {
		t.Errorf("missing snapshot: want ErrNotFound, got %v", err)
	}
}

func TestSnapshotPruneKeepsManual(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	seedSmallRoadmap(t, rm.ID)

	// A named snapshot that must survive pruning.
	kept, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotManual, strPtr("keep me"))
	if err != nil {
		t.Fatal(err)
	}

	// Create more auto snapshots than the cap; the oldest autos are pruned.
	for i := 0; i < maxAutoSnapshots+5; i++ {
		if _, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotAuto, nil); err != nil {
			t.Fatal(err)
		}
	}

	list, err := testStore.ListSnapshots(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	autos, manuals := 0, 0
	foundKept := false
	for _, s := range list {
		switch s.Kind {
		case model.SnapshotAuto:
			autos++
		case model.SnapshotManual:
			manuals++
		}
		if s.ID == kept.ID {
			foundKept = true
		}
	}
	if autos != maxAutoSnapshots {
		t.Errorf("auto snapshots after prune: want %d, got %d", maxAutoSnapshots, autos)
	}
	if manuals != 1 || !foundKept {
		t.Errorf("manual snapshot was pruned (manuals=%d, found=%v)", manuals, foundKept)
	}
}

func TestSnapshotDeleteAndCascade(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	seedSmallRoadmap(t, rm.ID)

	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotAuto, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := testStore.DeleteSnapshot(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	if err := testStore.DeleteSnapshot(ctx, snap.ID); err != ErrNotFound {
		t.Errorf("double delete: want ErrNotFound, got %v", err)
	}

	// Snapshots are removed when their roadmap is deleted (FK ON DELETE CASCADE).
	rm2, err := testStore.CreateRoadmap(ctx, "test-"+t.Name()+"-cascade")
	if err != nil {
		t.Fatal(err)
	}
	seedSmallRoadmap(t, rm2.ID)
	if _, err := testStore.CreateSnapshot(ctx, rm2.ID, model.SnapshotAuto, nil); err != nil {
		t.Fatal(err)
	}
	if err := testStore.DeleteRoadmap(ctx, rm2.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.ListSnapshots(ctx, rm2.ID); err != ErrNotFound {
		t.Errorf("snapshots survived roadmap delete: %v", err)
	}
}

func strPtr(s string) *string { return &s }
