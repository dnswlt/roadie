package store

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

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
		Title: "Launch", Date: date("2026-03-01"), Labels: []string{"release"},
		Flagged: true, Tentative: true, AtRisk: true}); err != nil {
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
	ms := full.Lanes[0].Milestones[0]
	if !slices.Equal(ms.Labels, []string{"release"}) || !ms.Flagged || !ms.Tentative || !ms.AtRisk {
		t.Errorf("snapshot lost milestone metadata: %+v", ms)
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
	if got.Lanes[0].ID != lane.ID {
		t.Errorf("restore reinserted lane under a fresh ID %d, want the original %d",
			got.Lanes[0].ID, lane.ID)
	}
	if n := len(got.Lanes[0].Items); n != 1 {
		t.Fatalf("items after restore: want 1, got %d", n)
	}
	if len(got.Lanes[0].Milestones) != 1 {
		t.Fatalf("restore lost milestone: %+v", got.Lanes[0].Milestones)
	}
	ms := got.Lanes[0].Milestones[0]
	if !slices.Equal(ms.Labels, []string{"release"}) || !ms.Flagged || !ms.Tentative || !ms.AtRisk {
		t.Errorf("restore lost milestone metadata: %+v", ms)
	}

	// Restore captured the pre-restore state as an extra auto snapshot.
	list, err := testStore.ListSnapshots(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("snapshots after restore: want 2 (original + pre-restore), got %d", len(list))
	}
	// The newest snapshot is the pre-restore capture; it must hold the exact
	// state that existed just before the restore (the diverged two-lane roadmap),
	// which is what capturing inside the restore lock guarantees.
	preRestore, err := testStore.GetSnapshotContents(ctx, list[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(preRestore.Lanes) != 2 {
		t.Fatalf("pre-restore snapshot: want the diverged 2-lane state, got %d lanes", len(preRestore.Lanes))
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

// insertAutoSnapshotAt inserts a bare auto snapshot with an explicit created_at,
// bypassing CreateSnapshot (and its prune) so a synthetic history can be laid
// out before pruning is exercised. The payload is a throwaway blob — these
// snapshots are only ever counted, never decoded.
func insertAutoSnapshotAt(t *testing.T, roadmapID int64, at time.Time) int64 {
	t.Helper()
	var id int64
	if err := testStore.pool.QueryRow(context.Background(),
		`INSERT INTO snapshots (roadmap_id, kind, format_version, data, created_at)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		roadmapID, model.SnapshotAuto, model.ExportVersion, []byte("{}"), at).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// runPrune runs pruneAutoSnapshots for roadmapID in its own committed transaction.
func runPrune(t *testing.T, roadmapID int64) {
	t.Helper()
	ctx := context.Background()
	tx, err := testStore.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := pruneAutoSnapshots(ctx, tx, roadmapID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestSnapshotTieredPrune(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	now := time.Now().UTC()

	// A named snapshot: never counted against the policy, must always survive.
	kept, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotManual, strPtr("keep me"))
	if err != nil {
		t.Fatal(err)
	}

	// Lay out a synthetic auto history spanning every tier. Same-bucket members
	// are placed a couple of minutes apart (never straddling a bucket boundary in
	// any timezone); cross-bucket members are separated by whole hours/days, well
	// clear of the tier cutoffs so the test doesn't race the wall clock.

	// < 1 day (keep all): 3 captures at distinct seconds -> 3 survivors.
	insertAutoSnapshotAt(t, rm.ID, now.Add(-10*time.Minute))
	insertAutoSnapshotAt(t, rm.ID, now.Add(-10*time.Minute-5*time.Second))
	insertAutoSnapshotAt(t, rm.ID, now.Add(-20*time.Minute))

	// 1–7 days (hourly): two in one hour + one 3h earlier -> 2 survivors.
	h := now.Add(-2 * 24 * time.Hour).Truncate(time.Hour).Add(15 * time.Minute)
	insertAutoSnapshotAt(t, rm.ID, h)
	insertAutoSnapshotAt(t, rm.ID, h.Add(2*time.Minute))
	insertAutoSnapshotAt(t, rm.ID, h.Add(-3*time.Hour))

	// Older than a week (daily): two in one day + one the next day -> 2 survivors.
	d := now.Add(-30 * 24 * time.Hour).Truncate(24 * time.Hour).Add(12 * time.Hour)
	insertAutoSnapshotAt(t, rm.ID, d)
	insertAutoSnapshotAt(t, rm.ID, d.Add(2*time.Minute))
	insertAutoSnapshotAt(t, rm.ID, d.Add(25*time.Hour))

	// Much older (still daily, kept forever): two in one day + one the next -> 2.
	o := now.Add(-200 * 24 * time.Hour).Truncate(24 * time.Hour).Add(12 * time.Hour)
	insertAutoSnapshotAt(t, rm.ID, o)
	insertAutoSnapshotAt(t, rm.ID, o.Add(2*time.Minute))
	insertAutoSnapshotAt(t, rm.ID, o.Add(25*time.Hour))

	runPrune(t, rm.ID)

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
	// 3 (day) + 2 (hourly) + 2 (daily) + 2 (daily forever) = 9 auto survivors.
	if autos != 9 {
		t.Errorf("auto snapshots after tiered prune: want 9, got %d", autos)
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
	rm2, err := testStore.CreateRoadmap(ctx, "test-"+t.Name()+"-cascade", Ownership{})
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

// A manual snapshot's name is what exempts it from pruning and what the client
// shows in place of its timestamp, so an unnamed one would be kept forever
// while reading as an ordinary auto capture. The store refuses to create one.
func TestSnapshotManualRequiresName(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	seedSmallRoadmap(t, rm.ID)

	if _, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotManual, nil); !isValidation(err) {
		t.Errorf("manual with no name: want validation error, got %v", err)
	}
	empty := ""
	if _, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotManual, &empty); !isValidation(err) {
		t.Errorf("manual with empty name: want validation error, got %v", err)
	}

	name := "After the Q3 review"
	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotManual, &name)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Kind != model.SnapshotManual || snap.Name == nil || *snap.Name != name {
		t.Fatalf("checkpoint metadata: %+v", snap)
	}
	// An auto capture still needs no name — that asymmetry is the point.
	if _, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotAuto, nil); err != nil {
		t.Fatalf("auto with no name: %v", err)
	}
}

// A restore re-creates the roadmap's entities under the database IDs the
// snapshot recorded, because a database ID names a logical entity rather than a
// physical row. This is the defining regression test for that: restore a
// snapshot and compare the result against the snapshot's own contents, which is
// exactly what the client-side version diff does. Same content, same IDs,
// nothing to report.
//
// The comparison is over the lane tree as JSON rather than field by field: the
// point is that *everything* the client sees comes back identical, and a check
// that listed the fields would quietly stop covering the next one added.
func TestRestorePreservesEntityIdentity(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane := seedSmallRoadmap(t, rm.ID)

	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotAuto, nil)
	if err != nil {
		t.Fatal(err)
	}
	want, err := testStore.GetSnapshotContents(ctx, snap.ID)
	if err != nil {
		t.Fatal(err)
	}

	// Diverge in every way a restore has to undo: an edit, an addition and a
	// deletion.
	if _, err := testStore.UpdateLane(ctx, lane.ID, LanePatch{
		Name: model.Opt[string]{Set: true, Value: "renamed"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateItem(ctx, lane.ID, NewItem{
		Title: "Later", StartDate: date("2026-04-01"), EndDate: date("2026-04-10")}); err != nil {
		t.Fatal(err)
	}
	for _, ms := range want.Lanes[0].Milestones {
		if err := testStore.DeleteMilestone(ctx, ms.ID); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := testStore.RestoreSnapshot(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	got, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if a, b := mustJSON(t, want.Lanes), mustJSON(t, got.Lanes); a != b {
		t.Errorf("restored contents differ from the snapshot\n snapshot: %s\n restored: %s", a, b)
	}
}

// Restoring what a restore produced must be a no-op on identity too: preserved
// IDs have to be stable under repetition, not merely equal once.
func TestRestoreOfRestoreIsStable(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane := seedSmallRoadmap(t, rm.ID)

	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotAuto, nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := testStore.RestoreSnapshot(ctx, snap.ID); err != nil {
			t.Fatalf("restore %d: %v", i, err)
		}
		full, err := testStore.GetRoadmapFull(ctx, rm.ID)
		if err != nil {
			t.Fatal(err)
		}
		if full.Lanes[0].ID != lane.ID {
			t.Fatalf("restore %d: lane ID %d, want %d", i, full.Lanes[0].ID, lane.ID)
		}
	}
}

// An entity the checkpoint does not contain stays gone, and its database ID is
// not handed to anything else: sequences never rewind, so a restore can reuse
// its own IDs without ever colliding with a future one.
func TestRestoreKeepsAbsentEntityGoneAndFreshIDsFresh(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane := seedSmallRoadmap(t, rm.ID)

	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotAuto, nil)
	if err != nil {
		t.Fatal(err)
	}
	added, err := testStore.CreateItem(ctx, lane.ID, NewItem{
		Title: "Added later", StartDate: date("2026-04-01"), EndDate: date("2026-04-10")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.RestoreSnapshot(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.UpdateItem(ctx, added.ID, ItemPatch{
		Title: model.Opt[string]{Set: true, Value: "x"}}); !errors.Is(err, ErrNotFound) {
		t.Errorf("item absent from the checkpoint: want ErrNotFound, got %v", err)
	}

	next, err := testStore.CreateItem(ctx, lane.ID, NewItem{
		Title: "After the restore", StartDate: date("2026-05-01"), EndDate: date("2026-05-10")})
	if err != nil {
		t.Fatal(err)
	}
	if next.ID <= added.ID {
		t.Errorf("insert after a restore got ID %d, which is not past the retired %d",
			next.ID, added.ID)
	}
}

// Snapshots taken before UIDs existed carry none. The milestone that currently
// holds that database ID hands its UID over; a milestone the roadmap no longer
// has simply gets a fresh one.
func TestRestorePreUIDSnapshotInheritsUIDs(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane := seedSmallRoadmap(t, rm.ID)
	gone, err := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{
		Title: "Dropped", Date: date("2026-07-01")})
	if err != nil {
		t.Fatal(err)
	}

	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	uidBefore := map[int64]string{}
	for _, ms := range full.Lanes[0].Milestones {
		uidBefore[ms.ID] = ms.UID
	}
	// A genuine pre-UID blob has no "uid" key at all, which decodes to exactly
	// this: the empty string.
	legacy := full
	legacy.Lanes = append([]model.LaneFull(nil), full.Lanes...)
	legacy.Lanes[0].Milestones = append([]model.Milestone(nil), full.Lanes[0].Milestones...)
	for i := range legacy.Lanes[0].Milestones {
		legacy.Lanes[0].Milestones[i].UID = ""
	}
	snapID := insertSnapshotBlob(t, rm.ID, legacy)

	// The milestone that is only in the blob has no row left to inherit from.
	if err := testStore.DeleteMilestone(ctx, gone.ID); err != nil {
		t.Fatal(err)
	}

	if _, err := testStore.RestoreSnapshot(ctx, snapID); err != nil {
		t.Fatal(err)
	}
	restored, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(restored.Lanes[0].Milestones); n != len(uidBefore) {
		t.Fatalf("milestones after restore: want %d, got %d", len(uidBefore), n)
	}
	for _, ms := range restored.Lanes[0].Milestones {
		switch {
		case ms.ID == gone.ID:
			// Nothing held that ID at restore time, so a fresh UID is the only
			// honest answer — and it must not be the one the deleted row had.
			if !validUID(ms.UID) || ms.UID == uidBefore[gone.ID] {
				t.Errorf("milestone %q: want a fresh UID, got %q", ms.Title, ms.UID)
			}
		case ms.UID != uidBefore[ms.ID]:
			t.Errorf("milestone %q did not inherit its UID: %q, want %q",
				ms.Title, ms.UID, uidBefore[ms.ID])
		}
	}
}

// A blob taken before lanes carried a timestamp has none to restore, and the
// restore must not write the zero time into the column. It is the last thing
// that wrote the row, so now() is the honest answer.
func TestRestoreOfBlobWithoutLaneTimestamp(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	seedSmallRoadmap(t, rm.ID)

	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	legacy := full
	legacy.Lanes = append([]model.LaneFull(nil), full.Lanes...)
	legacy.Lanes[0].UpdatedAt = time.Time{} // as an older blob decodes
	snapID := insertSnapshotBlob(t, rm.ID, legacy)

	before := time.Now().Add(-time.Minute)
	if _, err := testStore.RestoreSnapshot(ctx, snapID); err != nil {
		t.Fatal(err)
	}
	restored, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := restored.Lanes[0].UpdatedAt; !got.After(before) {
		t.Errorf("lane updated_at = %v, want the restore's own time", got)
	}
}

// insertSnapshotBlob stores full as a snapshot payload directly, bypassing
// CreateSnapshot so a test can capture a payload the current code would never
// produce (see TestRestorePreUIDSnapshotInheritsUIDs).
func insertSnapshotBlob(t *testing.T, roadmapID int64, full model.RoadmapFull) int64 {
	t.Helper()
	data, err := json.Marshal(model.RoadmapExport{
		Format: model.ExportFormat, Version: 1, Roadmap: full})
	if err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := testStore.pool.QueryRow(context.Background(),
		`INSERT INTO snapshots (roadmap_id, kind, format_version, data)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		roadmapID, model.SnapshotAuto, 1, data).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
