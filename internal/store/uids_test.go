package store

// Tests for the portable identities of notes/stable_uids.md — the roadmap UID
// and the milestone UID — and for the import modes that decide what an import
// does with the ones a file carries.

import (
	"context"
	"crypto/rand"
	"fmt"
	"strings"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

// testUID mints a well-formed UID for a hand-built import payload. Every import
// requires one for the roadmap and each milestone, and a fixture assembled in a
// test has no exported roadmap to have got it from.
func testUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// milestoneUIDs returns a roadmap's milestone UIDs keyed by title, which is how
// these tests identify a milestone across an operation that renumbers IDs.
func milestoneUIDs(t *testing.T, roadmapID int64) map[string]string {
	t.Helper()
	full, err := testStore.GetRoadmapFull(context.Background(), roadmapID)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, lane := range full.Lanes {
		for _, ms := range lane.Milestones {
			out[ms.Title] = ms.UID
		}
	}
	return out
}

// countRoadmapsNamed counts roadmaps of an exact name, trashed ones included —
// the atomicity checks need to see rows the API would hide.
func countRoadmapsNamed(t *testing.T, name string) int {
	t.Helper()
	var n int
	if err := testStore.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM roadmaps WHERE name = $1`, name).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestUIDsGeneratedOnCreate(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	if !validUID(rm.UID) {
		t.Fatalf("roadmap UID %q is not a UUID", rm.UID)
	}
	lane := seedSmallRoadmap(t, rm.ID)

	second, err := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{
		Title: "Second", Date: date("2026-04-01")})
	if err != nil {
		t.Fatal(err)
	}
	if !validUID(second.UID) {
		t.Fatalf("milestone UID %q is not a UUID", second.UID)
	}
	uids := milestoneUIDs(t, rm.ID)
	if uids["Launch"] == uids["Second"] {
		t.Errorf("two milestones share the UID %q", uids["Launch"])
	}
	if uids["Second"] != second.UID {
		t.Errorf("create returned UID %q, read back %q", second.UID, uids["Second"])
	}
}

// A UID must be immutable from creation: it is what something outside this
// roadmap holds on to.
func TestUIDsSurviveEdits(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane := seedSmallRoadmap(t, rm.ID)

	ms, err := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{
		Title: "Beta", Date: date("2026-05-01")})
	if err != nil {
		t.Fatal(err)
	}
	updated, err := testStore.UpdateMilestone(ctx, ms.ID, MilestonePatch{
		Title:     model.Opt[string]{Set: true, Value: "Beta (moved)"},
		Date:      model.Opt[model.Date]{Set: true, Value: date("2026-06-01")},
		Tentative: model.Opt[bool]{Set: true, Value: true}})
	if err != nil {
		t.Fatal(err)
	}
	if updated.UID != ms.UID {
		t.Errorf("milestone UID changed on edit: %q -> %q", ms.UID, updated.UID)
	}

	renamed, err := testStore.RenameRoadmap(ctx, rm.ID, rm.Name+" renamed")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.UID != rm.UID {
		t.Errorf("roadmap UID changed on rename: %q -> %q", rm.UID, renamed.UID)
	}
}

// Import as copy creates an independent roadmap every time. It must never
// consult what is already here to decide that — importing the same file twice
// predictably yields two unrelated roadmaps.
func TestImportCopyRegeneratesUIDs(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	seedSmallRoadmap(t, rm.ID)
	src, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}

	var uids []string
	for i := 0; i < 2; i++ {
		imported, err := testStore.ImportRoadmap(ctx, src, Ownership{}, ImportCopy)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), imported.ID) })
		if imported.UID == src.UID {
			t.Errorf("copy import %d kept the source roadmap UID %q", i, src.UID)
		}
		got := milestoneUIDs(t, imported.ID)
		if got["Launch"] == milestoneUIDs(t, rm.ID)["Launch"] {
			t.Errorf("copy import %d kept the source milestone UID", i)
		}
		uids = append(uids, imported.UID, got["Launch"])
	}
	if uids[0] == uids[2] || uids[1] == uids[3] {
		t.Error("two copy imports of the same file produced the same identities")
	}
}

// Duplicate is import-as-copy without the file, so it must regenerate identity
// too — and it must not reach that behaviour through anything that depends on
// what is already in the database.
func TestDuplicateRegeneratesUIDs(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	seedSmallRoadmap(t, rm.ID)

	dup, err := testStore.DuplicateRoadmap(ctx, rm.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), dup.ID) })

	if dup.UID == rm.UID {
		t.Errorf("duplicate kept the roadmap UID %q", rm.UID)
	}
	if got, src := milestoneUIDs(t, dup.ID)["Launch"], milestoneUIDs(t, rm.ID)["Launch"]; got == src {
		t.Errorf("duplicate kept the milestone UID %q", src)
	}
}

// Transfer brings in the roadmap the file names, under the identity the file
// carries. Simulated here by exporting, hard-deleting the source, and importing
// the file back.
func TestImportTransferPreservesUIDs(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	seedSmallRoadmap(t, rm.ID)
	src, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	srcMS := milestoneUIDs(t, rm.ID)
	if err := testStore.DeleteRoadmap(ctx, rm.ID); err != nil {
		t.Fatal(err)
	}

	moved, err := testStore.ImportRoadmap(ctx, src, Ownership{}, ImportTransfer)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), moved.ID) })

	if moved.UID != src.UID {
		t.Errorf("transfer changed the roadmap UID: %q -> %q", src.UID, moved.UID)
	}
	if moved.ID == rm.ID {
		t.Error("transfer reused the source database ID; only UIDs are portable")
	}
	if got := milestoneUIDs(t, moved.ID); got["Launch"] != srcMS["Launch"] {
		t.Errorf("transfer changed the milestone UID: %q -> %q", srcMS["Launch"], got["Launch"])
	}
}

// A transfer whose identity is already here writes nothing at all and says what
// it collided with. It never falls back to copy semantics.
func TestImportTransferConflictIsAtomic(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	seedSmallRoadmap(t, rm.ID)
	src, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	before := countRoadmapsNamed(t, src.Name+" (2)")

	_, err = testStore.ImportRoadmap(ctx, src, Ownership{}, ImportTransfer)
	if !isValidation(err) {
		t.Fatalf("transfer onto its own roadmap: want validation error, got %v", err)
	}
	if !strings.Contains(err.Error(), src.Name) {
		t.Errorf("error does not name the conflicting roadmap: %v", err)
	}

	// Only the milestone UID collides: a fresh roadmap identity, the same
	// milestone. The whole import must still be refused, not partially applied.
	msOnly := src
	msOnly.Roadmap.UID = "0b3f4b0e-5b3a-4f2a-9c1d-7e6a5c4b3a21"
	_, err = testStore.ImportRoadmap(ctx, msOnly, Ownership{}, ImportTransfer)
	if !isValidation(err) {
		t.Fatalf("transfer with a colliding milestone: want validation error, got %v", err)
	}
	if !strings.Contains(err.Error(), "Launch") {
		t.Errorf("error does not name the conflicting milestone: %v", err)
	}

	if after := countRoadmapsNamed(t, src.Name+" (2)"); after != before {
		t.Errorf("a refused transfer created %d roadmap(s)", after-before)
	}
}

// A trashed roadmap still holds its UID, so it still blocks a transfer — and
// the message has to point at the trash, since that is where the fix is.
func TestImportTransferConflictsWithTrashedRoadmap(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	seedSmallRoadmap(t, rm.ID)
	src, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := testStore.TrashRoadmap(ctx, rm.ID); err != nil {
		t.Fatal(err)
	}

	_, err = testStore.ImportRoadmap(ctx, src, Ownership{}, ImportTransfer)
	if !isValidation(err) {
		t.Fatalf("transfer onto a trashed roadmap: want validation error, got %v", err)
	}
	if !strings.Contains(err.Error(), "trash") {
		t.Errorf("error does not mention the trash: %v", err)
	}
}

// A file must carry a well-formed identity for the roadmap and every milestone,
// whichever mode it is imported in — an import file is user input, and one
// without identities is older than anything Roadie still accepts.
func TestImportRequiresWellFormedUIDs(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	seedSmallRoadmap(t, rm.ID)
	src, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}

	strip := func(mutate func(*model.RoadmapFull)) model.RoadmapFull {
		clone := src
		clone.Lanes = append([]model.LaneFull(nil), src.Lanes...)
		for i := range clone.Lanes {
			clone.Lanes[i].Milestones = append([]model.Milestone(nil), src.Lanes[i].Milestones...)
		}
		mutate(&clone)
		return clone
	}

	cases := map[string]model.RoadmapFull{
		"no roadmap UID":        strip(func(f *model.RoadmapFull) { f.Roadmap.UID = "" }),
		"malformed roadmap UID": strip(func(f *model.RoadmapFull) { f.Roadmap.UID = "not-a-uuid" }),
		"no milestone UID": strip(func(f *model.RoadmapFull) {
			f.Lanes[0].Milestones[0].UID = ""
		}),
		"malformed milestone UID": strip(func(f *model.RoadmapFull) {
			f.Lanes[0].Milestones[0].UID = "1234"
		}),
	}
	for name, bad := range cases {
		t.Run(name, func(t *testing.T) {
			for _, mode := range []ImportMode{ImportCopy, ImportTransfer} {
				if _, err := testStore.ImportRoadmap(ctx, bad, Ownership{}, mode); !isValidation(err) {
					t.Errorf("%s: want validation error, got %v", mode, err)
				}
			}
		})
	}
}

func TestImportRejectsUnknownMode(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	src, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.ImportRoadmap(ctx, src, Ownership{}, ImportMode("replace")); !isValidation(err) {
		t.Errorf("unknown mode: want validation error, got %v", err)
	}
}

func TestValidUID(t *testing.T) {
	good := []string{
		"0b3f4b0e-5b3a-4f2a-9c1d-7e6a5c4b3a21",
		"0B3F4B0E-5B3A-4F2A-9C1D-7E6A5C4B3A21",
	}
	bad := []string{
		"", "1234", "0b3f4b0e5b3a4f2a9c1d7e6a5c4b3a21",
		"0b3f4b0e-5b3a-4f2a-9c1d-7e6a5c4b3a2",   // too short
		"0b3f4b0e-5b3a-4f2a-9c1d-7e6a5c4b3a212", // too long
		"0b3f4b0e_5b3a-4f2a-9c1d-7e6a5c4b3a21",  // wrong separator
		"0b3f4b0e-5b3a-4f2a-9c1d-7e6a5c4b3g21",  // not hex
	}
	for _, s := range good {
		if !validUID(s) {
			t.Errorf("validUID(%q) = false, want true", s)
		}
	}
	for _, s := range bad {
		if validUID(s) {
			t.Errorf("validUID(%q) = true, want false", s)
		}
	}
}

// A transfer is refused by an identity that is already here whether or not the
// caller may see what holds it — but the refusal must not hand a stranger the
// name of a private roadmap, or the title of a milestone inside one. That is the
// rule uniqueRoadmapName already follows for the " (n)" suffix.
func TestImportTransferConflictHidesInvisibleNames(t *testing.T) {
	ctx := context.Background()
	const secret = "test-transfer-private-name"
	rm := newOwnedRoadmap(t, secret, model.VisibilityPrivate, ada)
	seedSmallRoadmap(t, rm.ID)
	src, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}

	// The roadmap UID collides, and the roadmap is invisible to the importer.
	_, err = testStore.ImportRoadmap(ctx, src, Ownership{Owner: grace}, ImportTransfer)
	if !isValidation(err) {
		t.Fatalf("transfer onto an invisible roadmap: want validation error, got %v", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Errorf("refusal names a roadmap the importer cannot see: %v", err)
	}

	// Only the milestone UID collides, so the milestone branch answers — and it
	// must hide the title and the roadmap name for the same reason.
	msOnly := src
	msOnly.Roadmap.UID = testUID()
	_, err = testStore.ImportRoadmap(ctx, msOnly, Ownership{Owner: grace}, ImportTransfer)
	if !isValidation(err) {
		t.Fatalf("transfer with an invisible milestone conflict: want validation error, got %v", err)
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "Launch") {
		t.Errorf("refusal names a milestone the importer cannot see: %v", err)
	}

	// The owner may see it, so they still get the name that tells them what to do.
	_, err = testStore.ImportRoadmap(ctx, src, Ownership{Owner: ada}, ImportTransfer)
	if !isValidation(err) || !strings.Contains(err.Error(), secret) {
		t.Errorf("owner's refusal should name the roadmap: %v", err)
	}
}

// A file that uses one milestone identity twice violates the unique index, so
// the preflight has to catch it: otherwise the insert fails halfway through and
// the caller gets an opaque internal error instead of a description of the file.
func TestImportTransferRejectsRepeatedMilestoneUID(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane := seedSmallRoadmap(t, rm.ID)
	if _, err := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{
		Title: "Beta", Date: date("2026-05-01")}); err != nil {
		t.Fatal(err)
	}
	src, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := testStore.DeleteRoadmap(ctx, rm.ID); err != nil {
		t.Fatal(err)
	}

	dup := src
	dup.Lanes = append([]model.LaneFull(nil), src.Lanes...)
	dup.Lanes[0].Milestones = append([]model.Milestone(nil), src.Lanes[0].Milestones...)
	// Same identity, spelled the other way: a UUID column compares by value.
	dup.Lanes[0].Milestones[1].UID = strings.ToUpper(dup.Lanes[0].Milestones[0].UID)

	moved, err := testStore.ImportRoadmap(ctx, dup, Ownership{}, ImportTransfer)
	if err == nil {
		t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), moved.ID) })
	}
	if !isValidation(err) {
		t.Fatalf("file repeating a milestone identity: want validation error, got %v", err)
	}
}
