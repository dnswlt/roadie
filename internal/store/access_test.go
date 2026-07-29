package store

import (
	"context"
	"errors"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

// Subjects used throughout. They only have to be non-empty and distinct: the
// store never interprets a subject, it only compares it.
const (
	ada   = "sub-ada"
	grace = "sub-grace"
	// anon is the empty subject an anonymous identity carries. Every assertion
	// that uses it is really asserting how Roadie behaves with auth off, where
	// this is what *every* caller looks like.
	anon = ""
)

// newOwnedRoadmap creates a roadmap with the given visibility and owner,
// cleaned up when the test finishes.
func newOwnedRoadmap(t *testing.T, name, visibility, owner string) model.Roadmap {
	t.Helper()
	rm, err := testStore.CreateRoadmap(context.Background(), name, Ownership{
		Visibility: visibility,
		Owner:      owner,
	})
	if err != nil {
		t.Fatalf("create %s roadmap: %v", visibility, err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })
	return rm
}

// TestRoadmapAccess is the access rule itself: public roadmaps are reachable by
// everybody including anonymous callers, private ones only by their members.
func TestRoadmapAccess(t *testing.T) {
	ctx := context.Background()
	pub := newOwnedRoadmap(t, "test-"+t.Name()+"-public", model.VisibilityPublic, ada)
	priv := newOwnedRoadmap(t, "test-"+t.Name()+"-private", model.VisibilityPrivate, ada)

	tests := []struct {
		name    string
		roadmap int64
		viewer  string
		want    error
	}{
		{"owner sees own private", priv.ID, ada, nil},
		{"stranger cannot see private", priv.ID, grace, ErrNotFound},
		{"anonymous cannot see private", priv.ID, anon, ErrNotFound},
		{"owner sees public", pub.ID, ada, nil},
		{"stranger sees public", pub.ID, grace, nil},
		{"anonymous sees public", pub.ID, anon, nil},
		// A roadmap that does not exist and one you may not see are reported
		// identically, so status codes cannot be used to probe for private
		// roadmaps.
		{"missing roadmap", 1 << 40, ada, ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := testStore.CanAccessRoadmap(ctx, tt.roadmap, tt.viewer); !errors.Is(err, tt.want) {
				t.Errorf("CanAccessRoadmap = %v, want %v", err, tt.want)
			}
		})
	}
}

// A private roadmap needs an owner or nobody could ever open it — which is also
// what stops an anonymous caller from creating one. Note that this is a check
// on the identity, not on the server's auth mode: the store has no idea which
// mode it is running under.
func TestCreatePrivateRoadmapNeedsOwner(t *testing.T) {
	ctx := context.Background()
	_, err := testStore.CreateRoadmap(ctx, "test-"+t.Name(), Ownership{
		Visibility: model.VisibilityPrivate,
		Owner:      anon,
	})
	if !isValidation(err) {
		t.Fatalf("anonymous private create: err = %v, want a validation error", err)
	}

	// An anonymous *public* create is fine, and is what every create looks like
	// with auth off.
	rm := newOwnedRoadmap(t, "test-"+t.Name()+"-ok", "", anon)
	if rm.Visibility != model.VisibilityPublic {
		t.Errorf("default visibility = %q, want %q", rm.Visibility, model.VisibilityPublic)
	}
	if rm.Owned {
		t.Error("an anonymously created roadmap must have no owner")
	}
}

func TestCreateRoadmapRejectsUnknownVisibility(t *testing.T) {
	_, err := testStore.CreateRoadmap(context.Background(), "test-"+t.Name(), Ownership{
		Visibility: "secret",
		Owner:      ada,
	})
	if !isValidation(err) {
		t.Fatalf("err = %v, want a validation error", err)
	}
}

// The listings are the one place the access rule is applied in SQL rather than
// by the server's route wrapper, because a listing has no roadmap id to check.
func TestListRoadmapsFiltersByVisibility(t *testing.T) {
	ctx := context.Background()
	pub := newOwnedRoadmap(t, "test-"+t.Name()+"-public", model.VisibilityPublic, ada)
	mine := newOwnedRoadmap(t, "test-"+t.Name()+"-mine", model.VisibilityPrivate, ada)
	theirs := newOwnedRoadmap(t, "test-"+t.Name()+"-theirs", model.VisibilityPrivate, grace)

	sees := func(viewer string, rm model.Roadmap) bool {
		t.Helper()
		list, err := testStore.ListRoadmaps(ctx, viewer)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range list {
			if r.ID == rm.ID {
				return true
			}
		}
		return false
	}

	if !sees(ada, pub) || !sees(grace, pub) || !sees(anon, pub) {
		t.Error("a public roadmap must be listed for everybody")
	}
	if !sees(ada, mine) {
		t.Error("the owner must see their own private roadmap")
	}
	if sees(grace, mine) || sees(anon, mine) {
		t.Error("a private roadmap must not be listed for non-members")
	}
	if !sees(grace, theirs) || sees(ada, theirs) {
		t.Error("private roadmaps must be listed for their own owner only")
	}
}

// Owned is what the UI keys the visibility control off, so it has to be per
// viewer rather than a property of the row.
func TestListRoadmapsReportsOwnership(t *testing.T) {
	ctx := context.Background()
	rm := newOwnedRoadmap(t, "test-"+t.Name(), model.VisibilityPublic, ada)

	ownedFor := func(viewer string) bool {
		t.Helper()
		list, err := testStore.ListRoadmaps(ctx, viewer)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range list {
			if r.ID == rm.ID {
				return r.Owned
			}
		}
		t.Fatalf("roadmap %d not listed for %q", rm.ID, viewer)
		return false
	}

	if !ownedFor(ada) {
		t.Error("the creator must own the roadmap, public or not")
	}
	if ownedFor(grace) || ownedFor(anon) {
		t.Error("only the creator owns it")
	}
}

// The trash is filtered by the same rule: deleting a private roadmap must not
// expose its name in somebody else's trash.
func TestListTrashedRoadmapsFiltersByVisibility(t *testing.T) {
	ctx := context.Background()
	rm := newOwnedRoadmap(t, "test-"+t.Name(), model.VisibilityPrivate, ada)
	if err := testStore.TrashRoadmap(ctx, rm.ID); err != nil {
		t.Fatal(err)
	}

	for _, viewer := range []string{grace, anon} {
		list, err := testStore.ListTrashedRoadmaps(ctx, viewer)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range list {
			if r.ID == rm.ID {
				t.Fatalf("viewer %q sees somebody else's trashed private roadmap", viewer)
			}
		}
	}
	list, err := testStore.ListTrashedRoadmaps(ctx, ada)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range list {
		found = found || r.ID == rm.ID
	}
	if !found {
		t.Error("the owner must find their own roadmap in the trash")
	}
}

// Access to a trashed roadmap is still decided, so its owner can restore or
// purge it and nobody else can. This is why the access predicate deliberately
// says nothing about deleted_at.
func TestAccessSurvivesTrashing(t *testing.T) {
	ctx := context.Background()
	rm := newOwnedRoadmap(t, "test-"+t.Name(), model.VisibilityPrivate, ada)
	if err := testStore.TrashRoadmap(ctx, rm.ID); err != nil {
		t.Fatal(err)
	}
	if err := testStore.CanAccessRoadmap(ctx, rm.ID, ada); err != nil {
		t.Errorf("owner lost access to their trashed roadmap: %v", err)
	}
	if err := testStore.CanAccessRoadmap(ctx, rm.ID, grace); !errors.Is(err, ErrNotFound) {
		t.Errorf("stranger access to trashed private roadmap = %v, want ErrNotFound", err)
	}
}

func TestSetRoadmapVisibility(t *testing.T) {
	ctx := context.Background()
	rm := newOwnedRoadmap(t, "test-"+t.Name(), model.VisibilityPublic, ada)

	// A stranger may see this public roadmap, but seeing is not owning.
	if _, err := testStore.SetRoadmapVisibility(ctx, rm.ID, model.VisibilityPrivate, grace); !errors.Is(err, ErrNotFound) {
		t.Errorf("non-owner set visibility = %v, want ErrNotFound", err)
	}
	if _, err := testStore.SetRoadmapVisibility(ctx, rm.ID, model.VisibilityPrivate, anon); !errors.Is(err, ErrNotFound) {
		t.Errorf("anonymous set visibility = %v, want ErrNotFound", err)
	}

	got, err := testStore.SetRoadmapVisibility(ctx, rm.ID, model.VisibilityPrivate, ada)
	if err != nil {
		t.Fatalf("owner set visibility: %v", err)
	}
	if got.Visibility != model.VisibilityPrivate || !got.Owned {
		t.Errorf("got %+v, want private and owned", got)
	}
	if err := testStore.CanAccessRoadmap(ctx, rm.ID, grace); !errors.Is(err, ErrNotFound) {
		t.Error("making a roadmap private must lock out everybody else")
	}

	// And back again — ownership does not change with visibility.
	if _, err := testStore.SetRoadmapVisibility(ctx, rm.ID, model.VisibilityPublic, ada); err != nil {
		t.Fatalf("owner set visibility back: %v", err)
	}
	if err := testStore.CanAccessRoadmap(ctx, rm.ID, grace); err != nil {
		t.Errorf("republished roadmap not visible: %v", err)
	}
}

// Roadmaps created with auth off have no owner, and nobody can claim one later.
// They are public forever, and that is the whole rule — no special case, just
// an ownership check that nobody can satisfy.
func TestUnownedRoadmapStaysPublic(t *testing.T) {
	ctx := context.Background()
	rm := newOwnedRoadmap(t, "test-"+t.Name(), model.VisibilityPublic, anon)

	for _, actor := range []string{ada, grace, anon} {
		if _, err := testStore.SetRoadmapVisibility(ctx, rm.ID, model.VisibilityPrivate, actor); !errors.Is(err, ErrNotFound) {
			t.Errorf("actor %q could change an unowned roadmap: err = %v, want ErrNotFound", actor, err)
		}
	}
}

// Renaming an import around a name you are not allowed to know would disclose
// it. The suffix is only applied for collisions the importer can actually see.
func TestUniqueNameIgnoresInvisibleRoadmaps(t *testing.T) {
	ctx := context.Background()
	name := "test-" + t.Name() + "-collide"
	newOwnedRoadmap(t, name, model.VisibilityPrivate, grace)

	imported, err := testStore.ImportRoadmap(ctx, model.RoadmapFull{
		Roadmap: model.Roadmap{Name: name},
	}, Ownership{Owner: ada})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), imported.ID) })

	if imported.Name != name {
		t.Errorf("name = %q, want %q — a private roadmap of another user must not push the import to a suffix",
			imported.Name, name)
	}
}

// An export file carries a visibility (Roadmap is embedded in the payload) and
// it must never be honoured: a file cannot publish itself, nor make itself
// private and belong to nobody.
func TestImportIgnoresFileVisibility(t *testing.T) {
	ctx := context.Background()
	imported, err := testStore.ImportRoadmap(ctx, model.RoadmapFull{
		Roadmap: model.Roadmap{Name: "test-" + t.Name(), Visibility: model.VisibilityPrivate},
	}, Ownership{Visibility: model.VisibilityPublic, Owner: ada})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), imported.ID) })

	if imported.Visibility != model.VisibilityPublic {
		t.Errorf("visibility = %q, want %q (the caller decides, not the file)",
			imported.Visibility, model.VisibilityPublic)
	}
}

// A copy is yours: it keeps the source's visibility so duplicating a private
// roadmap does not publish it, but it is owned by whoever made the copy.
func TestDuplicateInheritsVisibilityAndTakesNewOwner(t *testing.T) {
	ctx := context.Background()
	src := newOwnedRoadmap(t, "test-"+t.Name(), model.VisibilityPrivate, ada)

	copyRM, err := testStore.DuplicateRoadmap(ctx, src.ID, "test-"+t.Name()+"-copy", grace)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), copyRM.ID) })

	if copyRM.Visibility != model.VisibilityPrivate {
		t.Errorf("visibility = %q, want private", copyRM.Visibility)
	}
	if err := testStore.CanAccessRoadmap(ctx, copyRM.ID, grace); err != nil {
		t.Errorf("the copier cannot reach their own copy: %v", err)
	}
	owned, err := testStore.IsRoadmapOwner(ctx, copyRM.ID, grace)
	if err != nil || !owned {
		t.Errorf("IsRoadmapOwner(copier) = %v, %v; want true", owned, err)
	}
	if owned, _ := testStore.IsRoadmapOwner(ctx, copyRM.ID, ada); owned {
		t.Error("the source's owner must not own the copy")
	}
}

// Visibility is not roadmap content: it rides in the snapshot blob only because
// Roadmap is embedded in RoadmapFull, and restoring must ignore it. Otherwise
// going back to a January version would republish what you made private in June.
func TestRestoreSnapshotKeepsVisibility(t *testing.T) {
	ctx := context.Background()
	rm := newOwnedRoadmap(t, "test-"+t.Name(), model.VisibilityPublic, ada)

	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotManual, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.SetRoadmapVisibility(ctx, rm.ID, model.VisibilityPrivate, ada); err != nil {
		t.Fatal(err)
	}

	restored, err := testStore.RestoreSnapshot(ctx, snap.ID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Visibility != model.VisibilityPrivate {
		t.Errorf("visibility after restore = %q, want private — a restore must not republish a roadmap",
			restored.Visibility)
	}
	if err := testStore.CanAccessRoadmap(ctx, rm.ID, grace); !errors.Is(err, ErrNotFound) {
		t.Error("a restore reopened a private roadmap to everybody")
	}
}
