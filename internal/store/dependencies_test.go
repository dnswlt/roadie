package store

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

func itemRef(id int64) model.DependencyRef {
	return model.DependencyRef{Kind: model.DepItem, ID: id}
}

func msRef(id int64) model.DependencyRef {
	return model.DependencyRef{Kind: model.DepMilestone, ID: id}
}

// seedDepGraph builds a roadmap with one lane, items A/B/C and milestone M.
func seedDepGraph(t *testing.T) (rm model.Roadmap, a, b, c model.Item, m model.Milestone) {
	t.Helper()
	ctx := context.Background()
	rm = newRoadmap(t)
	lane, err := testStore.CreateLane(ctx, rm.ID, "Lane")
	if err != nil {
		t.Fatal(err)
	}
	mk := func(title string) model.Item {
		it, err := testStore.CreateItem(ctx, lane.ID, NewItem{
			Title: title, StartDate: date("2026-01-01"), EndDate: date("2026-02-01")})
		if err != nil {
			t.Fatal(err)
		}
		return it
	}
	a, b, c = mk("A"), mk("B"), mk("C")
	m, err = testStore.CreateMilestone(ctx, lane.ID, NewMilestone{Title: "M", Date: date("2026-03-01")})
	if err != nil {
		t.Fatal(err)
	}
	return rm, a, b, c, m
}

func TestDependencyCRUD(t *testing.T) {
	ctx := context.Background()
	rm, a, b, _, m := seedDepGraph(t)

	// B depends on A; milestone M depends on B.
	d1, err := testStore.CreateDependency(ctx, rm.ID, itemRef(a.ID), itemRef(b.ID))
	if err != nil {
		t.Fatal(err)
	}
	if d1.From != itemRef(a.ID) || d1.To != itemRef(b.ID) {
		t.Errorf("edge endpoints: %+v", d1)
	}
	var storedRoadmapID int64
	if err := testStore.pool.QueryRow(ctx,
		`SELECT roadmap_id FROM dependencies WHERE id = $1`, d1.ID).Scan(&storedRoadmapID); err != nil {
		t.Fatal(err)
	}
	if storedRoadmapID != rm.ID {
		t.Errorf("stored roadmap id: got %d, want %d", storedRoadmapID, rm.ID)
	}
	d2, err := testStore.CreateDependency(ctx, rm.ID, itemRef(b.ID), msRef(m.ID))
	if err != nil {
		t.Fatal(err)
	}

	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Dependencies) != 2 {
		t.Fatalf("dependencies in payload: got %d, want 2", len(full.Dependencies))
	}
	if full.Dependencies[0].ID != d1.ID || full.Dependencies[1].To != msRef(m.ID) {
		t.Errorf("payload edges: %+v", full.Dependencies)
	}

	if err := testStore.DeleteDependency(ctx, d2.ID); err != nil {
		t.Fatal(err)
	}
	if err := testStore.DeleteDependency(ctx, d2.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("double delete: want ErrNotFound, got %v", err)
	}
	full, err = testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Dependencies) != 1 {
		t.Errorf("dependencies after delete: got %d, want 1", len(full.Dependencies))
	}
}

func TestDependencyInvariants(t *testing.T) {
	ctx := context.Background()
	rm, a, b, c, m := seedDepGraph(t)
	_, oa, _, _, _ := seedDepGraph(t)

	if _, err := testStore.CreateDependency(ctx, rm.ID,
		model.DependencyRef{Kind: "lane", ID: a.ID}, itemRef(b.ID)); !isValidation(err) {
		t.Errorf("invalid kind: want validation error, got %v", err)
	}
	if _, err := testStore.CreateDependency(ctx, rm.ID, itemRef(a.ID), itemRef(a.ID)); !isValidation(err) {
		t.Errorf("self edge: want validation error, got %v", err)
	}
	// Item and milestone ids are separate spaces: a milestone with an item's id
	// is a different node, not a self edge (may or may not exist — here it does
	// not, so it must fail as unknown, not as "itself").
	if _, err := testStore.CreateDependency(ctx, rm.ID, itemRef(a.ID), msRef(a.ID)); !isValidation(err) {
		t.Errorf("unknown milestone: want validation error, got %v", err)
	}
	if _, err := testStore.CreateDependency(ctx, rm.ID, itemRef(-1), itemRef(b.ID)); !isValidation(err) {
		t.Errorf("unknown item: want validation error, got %v", err)
	}
	if _, err := testStore.CreateDependency(ctx, rm.ID, itemRef(oa.ID), itemRef(b.ID)); !isValidation(err) {
		t.Errorf("cross-roadmap endpoint: want validation error, got %v", err)
	}

	if _, err := testStore.CreateDependency(ctx, rm.ID, itemRef(a.ID), itemRef(b.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateDependency(ctx, rm.ID, itemRef(a.ID), itemRef(b.ID)); !isValidation(err) {
		t.Errorf("duplicate edge: want validation error, got %v", err)
	}

	// Direct cycle: B already depends on A, so A cannot depend on B — and the
	// rejection must say so in those terms.
	_, err := testStore.CreateDependency(ctx, rm.ID, itemRef(b.ID), itemRef(a.ID))
	if !isValidation(err) {
		t.Fatalf("direct cycle: want validation error, got %v", err)
	}
	if !strings.Contains(err.Error(), `"B" already depends on "A"`) {
		t.Errorf("direct cycle message: %q", err)
	}

	// Transitive cycle through a milestone: A → B (above), B → M, M → C, then
	// C → A must be rejected with the full chain spelled out.
	if _, err := testStore.CreateDependency(ctx, rm.ID, itemRef(b.ID), msRef(m.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateDependency(ctx, rm.ID, msRef(m.ID), itemRef(c.ID)); err != nil {
		t.Fatal(err)
	}
	_, err = testStore.CreateDependency(ctx, rm.ID, itemRef(c.ID), itemRef(a.ID))
	if !isValidation(err) {
		t.Fatalf("transitive cycle: want validation error, got %v", err)
	}
	for _, want := range []string{
		`"C" already depends on "A"`,
		`"C" needs milestone "M"`,
		`milestone "M" needs "B"`,
		`"B" needs "A"`,
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("transitive cycle message: %q missing %q", err, want)
		}
	}
}

func TestDependencyCascade(t *testing.T) {
	ctx := context.Background()
	rm, a, b, c, m := seedDepGraph(t)

	for _, e := range [][2]model.DependencyRef{
		{itemRef(a.ID), itemRef(b.ID)},
		{itemRef(b.ID), msRef(m.ID)},
		{itemRef(c.ID), msRef(m.ID)},
	} {
		if _, err := testStore.CreateDependency(ctx, rm.ID, e[0], e[1]); err != nil {
			t.Fatal(err)
		}
	}

	// Deleting an endpoint takes its edges along (FK cascade), on either side.
	if err := testStore.DeleteItem(ctx, b.ID); err != nil {
		t.Fatal(err)
	}
	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Dependencies) != 1 || full.Dependencies[0].From != itemRef(c.ID) {
		t.Fatalf("after item delete: %+v", full.Dependencies)
	}
	if err := testStore.DeleteMilestone(ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	full, err = testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Dependencies) != 0 {
		t.Fatalf("after milestone delete: %+v", full.Dependencies)
	}
}

// depByTitles renders a roadmap's edges as "from→to" strings over endpoint
// titles, so graphs can be compared across the id remapping of import/restore.
func depByTitles(t *testing.T, full model.RoadmapFull) []string {
	t.Helper()
	titles := map[model.DependencyRef]string{}
	for _, lane := range full.Lanes {
		for _, it := range lane.Items {
			titles[itemRef(it.ID)] = it.Title
			for _, ch := range it.Children {
				titles[itemRef(ch.ID)] = ch.Title
			}
		}
		for _, ms := range lane.Milestones {
			titles[msRef(ms.ID)] = "ms:" + ms.Title
		}
	}
	out := []string{}
	for _, d := range full.Dependencies {
		from, ok := titles[d.From]
		to, ok2 := titles[d.To]
		if !ok || !ok2 {
			t.Fatalf("edge %+v references endpoint outside the roadmap", d)
		}
		out = append(out, from+"→"+to)
	}
	return out
}

func TestDependencyImportRemapsIDs(t *testing.T) {
	ctx := context.Background()
	rm, a, b, _, m := seedDepGraph(t)

	if _, err := testStore.CreateDependency(ctx, rm.ID, itemRef(a.ID), itemRef(b.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateDependency(ctx, rm.ID, itemRef(b.ID), msRef(m.ID)); err != nil {
		t.Fatal(err)
	}
	src, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}

	imported, err := testStore.ImportRoadmap(ctx, src, Ownership{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), imported.ID) })

	got, err := testStore.GetRoadmapFull(ctx, imported.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"A→B", "B→ms:M"}
	if gotEdges := depByTitles(t, got); !slices.Equal(gotEdges, want) {
		t.Errorf("imported edges: %v, want %v", gotEdges, want)
	}
	// depByTitles already fails on endpoints outside the imported roadmap, so
	// passing means the ids were remapped, not copied.
}

func TestDependencyImportRejectsBadGraphs(t *testing.T) {
	ctx := context.Background()
	rm, a, b, _, _ := seedDepGraph(t)
	src, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}

	cyclic := src
	cyclic.Dependencies = []model.Dependency{
		{From: itemRef(a.ID), To: itemRef(b.ID)},
		{From: itemRef(b.ID), To: itemRef(a.ID)},
	}
	_, err = testStore.ImportRoadmap(ctx, cyclic, Ownership{})
	if !isValidation(err) {
		t.Fatalf("cyclic import: want validation error, got %v", err)
	}
	if !strings.Contains(err.Error(), "cycle") || !strings.Contains(err.Error(), `"A" needs "B"`) {
		t.Errorf("cyclic import message: %q", err)
	}

	dangling := src
	dangling.Dependencies = []model.Dependency{{From: itemRef(a.ID), To: itemRef(999999)}}
	if _, err := testStore.ImportRoadmap(ctx, dangling, Ownership{}); !isValidation(err) {
		t.Errorf("dangling import: want validation error, got %v", err)
	}
}

func TestDependencySnapshotRestore(t *testing.T) {
	ctx := context.Background()
	rm, a, b, c, _ := seedDepGraph(t)

	if _, err := testStore.CreateDependency(ctx, rm.ID, itemRef(a.ID), itemRef(b.ID)); err != nil {
		t.Fatal(err)
	}
	snap, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotManual, strPtr("checkpoint"))
	if err != nil {
		t.Fatal(err)
	}

	// Diverge: drop the captured edge, add a different one.
	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := testStore.DeleteDependency(ctx, full.Dependencies[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateDependency(ctx, rm.ID, itemRef(b.ID), itemRef(c.ID)); err != nil {
		t.Fatal(err)
	}

	if _, err := testStore.RestoreSnapshot(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	restored, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := depByTitles(t, restored); !slices.Equal(got, []string{"A→B"}) {
		t.Errorf("restored edges: %v, want [A→B]", got)
	}
}
