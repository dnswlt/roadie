package store

import (
	"context"
	"errors"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

func opt(s string) model.Opt[string] { return model.Opt[string]{Set: true, Value: s} }

func TestTrackerQueryCRUD(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)

	// Stored trimmed: a padded name is indistinguishable in the picker.
	q1, err := testStore.CreateTrackerQuery(ctx, rm.ID, "  Epics  ", " project = PAY AND issuetype = Epic ")
	if err != nil {
		t.Fatal(err)
	}
	if q1.Name != "Epics" || q1.Query != "project = PAY AND issuetype = Epic" || q1.RoadmapID != rm.ID {
		t.Fatalf("created = %+v", q1)
	}

	q2, err := testStore.CreateTrackerQuery(ctx, rm.ID, "All open", "status != Done")
	if err != nil {
		t.Fatal(err)
	}

	// Listed by name, not creation order.
	queries, err := testStore.ListTrackerQueries(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(queries) != 2 || queries[0].Name != "All open" || queries[1].Name != "Epics" {
		t.Fatalf("list = %+v", queries)
	}

	// The guard's resolver.
	if id, err := testStore.RoadmapIDByTrackerQuery(ctx, q1.ID); err != nil || id != rm.ID {
		t.Fatalf("RoadmapIDByTrackerQuery = %d, %v", id, err)
	}

	// Update: each field alone, the other untouched.
	upd, err := testStore.UpdateTrackerQuery(ctx, q2.ID, TrackerQueryPatch{Query: opt("status = Open")})
	if err != nil {
		t.Fatal(err)
	}
	if upd.Name != "All open" || upd.Query != "status = Open" {
		t.Fatalf("updated = %+v", upd)
	}
	upd, err = testStore.UpdateTrackerQuery(ctx, q2.ID, TrackerQueryPatch{Name: opt("Open items")})
	if err != nil {
		t.Fatal(err)
	}
	if upd.Name != "Open items" || upd.Query != "status = Open" {
		t.Fatalf("renamed = %+v", upd)
	}

	if err := testStore.DeleteTrackerQuery(ctx, q1.ID); err != nil {
		t.Fatal(err)
	}
	if err := testStore.DeleteTrackerQuery(ctx, q1.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v", err)
	}
	queries, err = testStore.ListTrackerQueries(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(queries) != 1 || queries[0].ID != q2.ID {
		t.Fatalf("list after delete = %+v", queries)
	}
}

func TestTrackerQueryValidation(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)

	assertInvalid := func(err error, what string) {
		t.Helper()
		if !isValidation(err) {
			t.Fatalf("%s = %v, want ValidationError", what, err)
		}
	}

	_, err := testStore.CreateTrackerQuery(ctx, rm.ID, "  ", "q")
	assertInvalid(err, "empty name")
	_, err = testStore.CreateTrackerQuery(ctx, rm.ID, "n", "  ")
	assertInvalid(err, "empty query")

	q, err := testStore.CreateTrackerQuery(ctx, rm.ID, "Epics", "type = Epic")
	if err != nil {
		t.Fatal(err)
	}
	// Names are unique per roadmap; the same name elsewhere is fine.
	_, err = testStore.CreateTrackerQuery(ctx, rm.ID, "Epics", "other")
	assertInvalid(err, "duplicate name")
	other := newRoadmap(t)
	if _, err := testStore.CreateTrackerQuery(ctx, other.ID, "Epics", "type = Epic"); err != nil {
		t.Fatalf("same name in another roadmap: %v", err)
	}

	// A rename may not collide either, but updating a query in place keeps its
	// own name without tripping the check.
	q2, err := testStore.CreateTrackerQuery(ctx, rm.ID, "Open", "status = Open")
	if err != nil {
		t.Fatal(err)
	}
	_, err = testStore.UpdateTrackerQuery(ctx, q2.ID, TrackerQueryPatch{Name: opt("Epics")})
	assertInvalid(err, "rename collision")
	if _, err := testStore.UpdateTrackerQuery(ctx, q2.ID, TrackerQueryPatch{Name: opt("Open"), Query: opt("status != Done")}); err != nil {
		t.Fatalf("keep own name: %v", err)
	}

	_, err = testStore.UpdateTrackerQuery(ctx, q.ID, TrackerQueryPatch{Name: opt("  ")})
	assertInvalid(err, "rename to empty")
	if _, err := testStore.UpdateTrackerQuery(ctx, 999999, TrackerQueryPatch{Name: opt("x")}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("update missing = %v", err)
	}
	if _, err := testStore.RoadmapIDByTrackerQuery(ctx, 999999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("resolve missing = %v", err)
	}
}

func TestTrackerQueriesStayOutOfRoadmapContent(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	if _, err := testStore.CreateTrackerQuery(ctx, rm.ID, "Epics", "type = Epic"); err != nil {
		t.Fatal(err)
	}

	// Not content: a duplicate carries the lanes but no favourites.
	dup, err := testStore.DuplicateRoadmap(ctx, rm.ID, "test-"+t.Name()+"-copy", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), dup.ID) })
	queries, err := testStore.ListTrackerQueries(ctx, dup.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(queries) != 0 {
		t.Fatalf("duplicate carried favourites: %+v", queries)
	}

	// Roadmap-scoped: deleting the roadmap cascades onto its saved queries.
	if err := testStore.DeleteRoadmap(ctx, rm.ID); err != nil {
		t.Fatal(err)
	}
	queries, err = testStore.ListTrackerQueries(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(queries) != 0 {
		t.Fatalf("favourites survived the purge: %+v", queries)
	}
}
