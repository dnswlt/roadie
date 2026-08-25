package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dnswlt/roadie/internal/model"
)

var testStore *Store

func TestMain(m *testing.M) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		// No database available (e.g. CI without services); skip all tests.
		os.Exit(0)
	}
	ctx := context.Background()
	st, err := Connect(ctx, url)
	if err != nil {
		panic(err)
	}
	if err := st.Migrate(ctx); err != nil {
		panic(err)
	}
	testStore = st
	code := m.Run()
	st.Close()
	os.Exit(code)
}

// newRoadmap creates a roadmap that is deleted when the test finishes.
func newRoadmap(t *testing.T) model.Roadmap {
	t.Helper()
	ctx := context.Background()
	rm, err := testStore.CreateRoadmap(ctx, "test-"+t.Name(), Ownership{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })
	return rm
}

func date(s string) model.Date {
	d, err := model.ParseDate(s)
	if err != nil {
		panic(err)
	}
	return d
}

func isValidation(err error) bool {
	var ve *ValidationError
	return errors.As(err, &ve)
}

func TestRoadmapCRUD(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)

	renamed, err := testStore.RenameRoadmap(ctx, rm.ID, "renamed")
	if err != nil || renamed.Name != "renamed" {
		t.Fatalf("rename: %v, name=%q", err, renamed.Name)
	}
	if !renamed.UpdatedAt.After(rm.UpdatedAt) && !renamed.UpdatedAt.Equal(rm.UpdatedAt) {
		t.Errorf("updated_at not advanced")
	}
	if _, err := testStore.RenameRoadmap(ctx, -1, "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("rename missing roadmap: want ErrNotFound, got %v", err)
	}
	if _, err := testStore.CreateRoadmap(ctx, "", Ownership{}); !isValidation(err) {
		t.Errorf("empty name: want validation error, got %v", err)
	}
	list, err := testStore.ListRoadmaps(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range list {
		if r.ID == rm.ID {
			found = true
		}
	}
	if !found {
		t.Errorf("roadmap not in list")
	}
}

func TestLanesAndReorder(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)

	a, err := testStore.CreateLane(ctx, rm.ID, "A")
	if err != nil {
		t.Fatal(err)
	}
	b, err := testStore.CreateLane(ctx, rm.ID, "B")
	if err != nil {
		t.Fatal(err)
	}
	c, err := testStore.CreateLane(ctx, rm.ID, "C")
	if err != nil {
		t.Fatal(err)
	}
	if a.Position != 0 || b.Position != 1 || c.Position != 2 {
		t.Fatalf("positions: %d %d %d", a.Position, b.Position, c.Position)
	}

	if err := testStore.ReorderLanes(ctx, rm.ID, []int64{c.ID, a.ID, b.ID}); err != nil {
		t.Fatal(err)
	}
	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	got := [3]int64{full.Lanes[0].ID, full.Lanes[1].ID, full.Lanes[2].ID}
	want := [3]int64{c.ID, a.ID, b.ID}
	if got != want {
		t.Errorf("lane order: got %v want %v", got, want)
	}

	if err := testStore.ReorderLanes(ctx, rm.ID, []int64{a.ID, b.ID}); !isValidation(err) {
		t.Errorf("partial reorder: want validation error, got %v", err)
	}
	if err := testStore.ReorderLanes(ctx, rm.ID, []int64{a.ID, a.ID, b.ID}); !isValidation(err) {
		t.Errorf("duplicate reorder: want validation error, got %v", err)
	}

	if _, err := testStore.CreateLane(ctx, -1, "X"); !errors.Is(err, ErrNotFound) {
		t.Errorf("lane for missing roadmap: want ErrNotFound, got %v", err)
	}

	// Colors are auto-assigned round-robin on creation.
	if a.Color != "blue" || b.Color != "green" || c.Color != "red" {
		t.Errorf("auto colors: got %s %s %s", a.Color, b.Color, c.Color)
	}
	upd, err := testStore.UpdateLane(ctx, a.ID, LanePatch{
		Color: model.Opt[string]{Set: true, Value: "purple"},
	})
	if err != nil || upd.Color != "purple" || upd.Name != "A" {
		t.Errorf("color update: %v, %+v", err, upd)
	}
	if _, err := testStore.UpdateLane(ctx, a.ID, LanePatch{
		Color: model.Opt[string]{Set: true, Value: "mauve"},
	}); !isValidation(err) {
		t.Errorf("invalid color: want validation error, got %v", err)
	}
	renamed, err := testStore.UpdateLane(ctx, a.ID, LanePatch{
		Name: model.Opt[string]{Set: true, Value: "A2"},
	})
	if err != nil || renamed.Name != "A2" || renamed.Color != "purple" {
		t.Errorf("rename keeps color: %v, %+v", err, renamed)
	}
}

func TestItemInvariants(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane1, _ := testStore.CreateLane(ctx, rm.ID, "L1")
	lane2, _ := testStore.CreateLane(ctx, rm.ID, "L2")

	parent, err := testStore.CreateItem(ctx, lane1.ID, NewItem{
		Title: "Parent", StartDate: date("2026-01-01"), EndDate: date("2026-06-30"),
	})
	if err != nil {
		t.Fatal(err)
	}

	// Child created "in lane2" but adopts parent's lane.
	child, err := testStore.CreateItem(ctx, lane2.ID, NewItem{
		Title: "Child", StartDate: date("2026-02-01"), EndDate: date("2026-03-31"),
		ParentID: &parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if child.LaneID != lane1.ID {
		t.Errorf("child lane: got %d want %d", child.LaneID, lane1.ID)
	}

	// No second nesting level.
	if _, err := testStore.CreateItem(ctx, lane1.ID, NewItem{
		Title: "Grandchild", StartDate: date("2026-02-01"), EndDate: date("2026-02-28"),
		ParentID: &child.ID,
	}); !isValidation(err) {
		t.Errorf("grandchild: want validation error, got %v", err)
	}

	// Invalid dates.
	if _, err := testStore.CreateItem(ctx, lane1.ID, NewItem{
		Title: "Bad", StartDate: date("2026-05-01"), EndDate: date("2026-04-01"),
	}); !isValidation(err) {
		t.Errorf("end before start: want validation error, got %v", err)
	}

	// A parent cannot become a child.
	other, _ := testStore.CreateItem(ctx, lane1.ID, NewItem{
		Title: "Other", StartDate: date("2026-01-01"), EndDate: date("2026-02-01"),
	})
	if _, err := testStore.UpdateItem(ctx, parent.ID, ItemPatch{
		ParentID: model.Opt[*int64]{Set: true, Value: &other.ID},
	}); !isValidation(err) {
		t.Errorf("parent as child: want validation error, got %v", err)
	}

	// An item cannot be its own parent.
	if _, err := testStore.UpdateItem(ctx, other.ID, ItemPatch{
		ParentID: model.Opt[*int64]{Set: true, Value: &other.ID},
	}); !isValidation(err) {
		t.Errorf("self parent: want validation error, got %v", err)
	}

	// A child cannot change lanes on its own.
	if _, err := testStore.UpdateItem(ctx, child.ID, ItemPatch{
		LaneID: model.Opt[int64]{Set: true, Value: lane2.ID},
	}); !isValidation(err) {
		t.Errorf("child lane change: want validation error, got %v", err)
	}

	// Moving the parent moves the children.
	moved, err := testStore.UpdateItem(ctx, parent.ID, ItemPatch{
		LaneID: model.Opt[int64]{Set: true, Value: lane2.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if moved.LaneID != lane2.ID {
		t.Errorf("parent lane after move: got %d", moved.LaneID)
	}
	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ln := range full.Lanes {
		for _, it := range ln.Items {
			if it.ID == parent.ID {
				if ln.ID != lane2.ID {
					t.Errorf("parent rendered in lane %d", ln.ID)
				}
				if len(it.Children) != 1 || it.Children[0].LaneID != lane2.ID {
					t.Errorf("child did not follow parent: %+v", it.Children)
				}
			}
		}
	}

	// Detach child, then move it to another lane.
	detached, err := testStore.UpdateItem(ctx, child.ID, ItemPatch{
		ParentID: model.Opt[*int64]{Set: true, Value: nil},
		LaneID:   model.Opt[int64]{Set: true, Value: lane1.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if detached.ParentID != nil || detached.LaneID != lane1.ID {
		t.Errorf("detach: %+v", detached)
	}

	// Deleting a parent cascades to children.
	child2, _ := testStore.CreateItem(ctx, lane2.ID, NewItem{
		Title: "Child2", StartDate: date("2026-02-01"), EndDate: date("2026-02-15"),
		ParentID: &parent.ID,
	})
	if err := testStore.DeleteItem(ctx, parent.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.UpdateItem(ctx, child2.ID, ItemPatch{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("child after parent delete: want ErrNotFound, got %v", err)
	}
}

func TestItemRanks(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane1, _ := testStore.CreateLane(ctx, rm.ID, "L1")
	lane2, _ := testStore.CreateLane(ctx, rm.ID, "L2")

	mk := func(title string) model.Item {
		it, err := testStore.CreateItem(ctx, lane1.ID, NewItem{
			Title: title, StartDate: date("2026-01-01"), EndDate: date("2026-02-01"),
		})
		if err != nil {
			t.Fatal(err)
		}
		return it
	}
	a, b, c := mk("A"), mk("B"), mk("C")
	if a.Rank != 0 || b.Rank != 1 || c.Rank != 2 {
		t.Fatalf("create ranks: %d %d %d", a.Rank, b.Rank, c.Rank)
	}

	laneOrder := func(laneID int64) []string {
		t.Helper()
		full, err := testStore.GetRoadmapFull(ctx, rm.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, ln := range full.Lanes {
			if ln.ID == laneID {
				var titles []string
				for i, it := range ln.Items {
					if it.Rank != i {
						t.Errorf("lane %d: item %q has rank %d at index %d", laneID, it.Title, it.Rank, i)
					}
					titles = append(titles, it.Title)
				}
				return titles
			}
		}
		return nil
	}

	// Move C to the top.
	if _, err := testStore.UpdateItem(ctx, c.ID, ItemPatch{
		Rank: model.Opt[int]{Set: true, Value: 0},
	}); err != nil {
		t.Fatal(err)
	}
	if got := laneOrder(lane1.ID); got[0] != "C" || got[1] != "A" || got[2] != "B" {
		t.Errorf("after move to top: %v", got)
	}

	// Delete the middle item (A, rank 1): ranks stay dense.
	if err := testStore.DeleteItem(ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if got := laneOrder(lane1.ID); len(got) != 2 || got[0] != "C" || got[1] != "B" {
		t.Errorf("after delete: %v", got)
	}

	// Cross-lane move without an explicit rank appends.
	moved, err := testStore.UpdateItem(ctx, c.ID, ItemPatch{
		LaneID: model.Opt[int64]{Set: true, Value: lane2.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if moved.Rank != 0 {
		t.Errorf("appended rank in empty lane: %d", moved.Rank)
	}
	if got := laneOrder(lane1.ID); len(got) != 1 || got[0] != "B" {
		t.Errorf("source lane after cross-lane move: %v", got)
	}

	// Out-of-range ranks are clamped.
	clamped, err := testStore.UpdateItem(ctx, c.ID, ItemPatch{
		Rank: model.Opt[int]{Set: true, Value: 99},
	})
	if err != nil || clamped.Rank != 0 {
		t.Errorf("clamped rank: %v, %d", err, clamped.Rank)
	}

	// Children rank within their parent.
	c1, _ := testStore.CreateItem(ctx, lane1.ID, NewItem{
		Title: "b-child1", StartDate: date("2026-01-01"), EndDate: date("2026-01-10"), ParentID: &b.ID,
	})
	c2, err := testStore.CreateItem(ctx, lane1.ID, NewItem{
		Title: "b-child2", StartDate: date("2026-01-05"), EndDate: date("2026-01-15"), ParentID: &b.ID,
	})
	if err != nil || c1.Rank != 0 || c2.Rank != 1 {
		t.Fatalf("child ranks: %v, %d %d", err, c1.Rank, c2.Rank)
	}
	if _, err := testStore.UpdateItem(ctx, c2.ID, ItemPatch{
		Rank: model.Opt[int]{Set: true, Value: 0},
	}); err != nil {
		t.Fatal(err)
	}
	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ln := range full.Lanes {
		for _, it := range ln.Items {
			if it.ID == b.ID {
				if len(it.Children) != 2 || it.Children[0].Title != "b-child2" {
					t.Errorf("child order: %+v", it.Children)
				}
			}
		}
	}
}

func TestItemUpdateFields(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane, _ := testStore.CreateLane(ctx, rm.ID, "L")
	it, err := testStore.CreateItem(ctx, lane.ID, NewItem{
		Title: "T", Description: "D",
		StartDate: date("2026-01-01"), EndDate: date("2026-02-01"),
	})
	if err != nil {
		t.Fatal(err)
	}
	upd, err := testStore.UpdateItem(ctx, it.ID, ItemPatch{
		Title:       model.Opt[string]{Set: true, Value: "T2"},
		Description: model.Opt[string]{Set: true, Value: ""},
		StartDate:   model.Opt[model.Date]{Set: true, Value: date("2026-01-15")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if upd.Title != "T2" || upd.Description != "" || !upd.StartDate.Equal(date("2026-01-15").Time) {
		t.Errorf("update result: %+v", upd)
	}
	if upd.EndDate.Format(time.DateOnly) != "2026-02-01" {
		t.Errorf("end date changed unexpectedly: %v", upd.EndDate)
	}
	if _, err := testStore.UpdateItem(ctx, it.ID, ItemPatch{
		Title: model.Opt[string]{Set: true, Value: ""},
	}); !isValidation(err) {
		t.Errorf("empty title: want validation error, got %v", err)
	}
}

func TestItemLabels(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane, _ := testStore.CreateLane(ctx, rm.ID, "L")
	it, err := testStore.CreateItem(ctx, lane.ID, NewItem{
		Title: "T", StartDate: date("2026-01-01"), EndDate: date("2026-02-01"),
	})
	if err != nil {
		t.Fatal(err)
	}
	// New items start with an empty (non-nil) label set.
	if it.Labels == nil || len(it.Labels) != 0 {
		t.Errorf("new item labels: want empty non-nil, got %#v", it.Labels)
	}

	// Setting labels normalizes: trims, drops empties, de-dupes, keeps order.
	upd, err := testStore.UpdateItem(ctx, it.ID, ItemPatch{
		Labels: model.Opt[[]string]{Set: true, Value: []string{" Needs discussion ", "backend", "", "backend", "Needs discussion"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(upd.Labels) != 2 || upd.Labels[0] != "Needs discussion" || upd.Labels[1] != "backend" {
		t.Errorf("normalized labels: %#v", upd.Labels)
	}

	// A patch that omits labels leaves them intact.
	upd2, err := testStore.UpdateItem(ctx, it.ID, ItemPatch{
		Title: model.Opt[string]{Set: true, Value: "T2"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(upd2.Labels) != 2 {
		t.Errorf("labels not preserved across unrelated patch: %#v", upd2.Labels)
	}

	// Clearing labels with an explicit empty set.
	upd3, err := testStore.UpdateItem(ctx, it.ID, ItemPatch{
		Labels: model.Opt[[]string]{Set: true, Value: []string{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(upd3.Labels) != 0 {
		t.Errorf("cleared labels: %#v", upd3.Labels)
	}

	// Labels survive the full-roadmap read path.
	if _, err := testStore.UpdateItem(ctx, it.ID, ItemPatch{
		Labels: model.Opt[[]string]{Set: true, Value: []string{"x"}},
	}); err != nil {
		t.Fatal(err)
	}
	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := full.Lanes[0].Items[0].Labels; len(got) != 1 || got[0] != "x" {
		t.Errorf("labels from GetRoadmapFull: %#v", got)
	}
}

// TestItemCreateRank covers creating into an explicit slot: NewItem.Rank shifts
// the siblings at or after it and keeps the container dense, so "new item
// directly below this one" is one request rather than a create-then-move.
func TestItemCreateRank(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane, _ := testStore.CreateLane(ctx, rm.ID, "L")

	mk := func(title string, rank model.Opt[int], parent *int64) model.Item {
		t.Helper()
		it, err := testStore.CreateItem(ctx, lane.ID, NewItem{
			Title: title, StartDate: date("2026-01-01"), EndDate: date("2026-02-01"),
			ParentID: parent, Rank: rank,
		})
		if err != nil {
			t.Fatal(err)
		}
		return it
	}
	at := func(i int) model.Opt[int] { return model.Opt[int]{Set: true, Value: i} }
	var append_ model.Opt[int] // unset = append

	order := func(parent *int64) []string {
		t.Helper()
		full, err := testStore.GetRoadmapFull(ctx, rm.ID)
		if err != nil {
			t.Fatal(err)
		}
		items := full.Lanes[0].Items
		var titles []string
		if parent == nil {
			for i, it := range items {
				if it.Rank != i {
					t.Errorf("top level: %q has rank %d at index %d", it.Title, it.Rank, i)
				}
				titles = append(titles, it.Title)
			}
			return titles
		}
		for _, it := range items {
			if it.ID != *parent {
				continue
			}
			for i, c := range it.Children {
				if c.Rank != i {
					t.Errorf("children of %d: %q has rank %d at index %d", *parent, c.Title, c.Rank, i)
				}
				titles = append(titles, c.Title)
			}
		}
		return titles
	}

	// No rank keeps appending, as every existing create path relies on.
	a, b, c := mk("A", append_, nil), mk("B", append_, nil), mk("C", append_, nil)
	if a.Rank != 0 || b.Rank != 1 || c.Rank != 2 {
		t.Fatalf("append ranks: %d %d %d", a.Rank, b.Rank, c.Rank)
	}

	// The "n"/"+ Add sibling" case: directly after B (rank 1) is rank 2.
	nb := mk("after-B", at(b.Rank+1), nil)
	if nb.Rank != 2 {
		t.Errorf("insert after B: rank %d, want 2", nb.Rank)
	}
	if got := order(nil); !slices.Equal(got, []string{"A", "B", "after-B", "C"}) {
		t.Errorf("after inserting below B: %v", got)
	}

	// Rank 0 is a real slot, not "unspecified" — the reason NewItem.Rank is Opt.
	if first := mk("first", at(0), nil); first.Rank != 0 {
		t.Errorf("insert at 0: rank %d", first.Rank)
	}
	if got := order(nil); !slices.Equal(got, []string{"first", "A", "B", "after-B", "C"}) {
		t.Errorf("after inserting at 0: %v", got)
	}

	// Out-of-range ranks clamp instead of erroring or tearing the sequence.
	if high := mk("high", at(99), nil); high.Rank != 5 {
		t.Errorf("rank 99 in a 5-item container: got %d, want 5 (clamped)", high.Rank)
	}
	if low := mk("low", at(-3), nil); low.Rank != 0 {
		t.Errorf("negative rank: got %d, want 0 (clamped)", low.Rank)
	}
	if got := order(nil); !slices.Equal(got, []string{"low", "first", "A", "B", "after-B", "C", "high"}) {
		t.Errorf("after clamped inserts: %v", got)
	}

	// Children are their own container: a rank there must not disturb top level.
	x := mk("X", append_, &a.ID)
	mk("Y", append_, &a.ID)
	mid := mk("mid", at(x.Rank+1), &a.ID)
	if mid.Rank != 1 {
		t.Errorf("child insert after X: rank %d, want 1", mid.Rank)
	}
	if got := order(&a.ID); !slices.Equal(got, []string{"X", "mid", "Y"}) {
		t.Errorf("children after insert: %v", got)
	}
	if got := order(nil); !slices.Equal(got, []string{"low", "first", "A", "B", "after-B", "C", "high"}) {
		t.Errorf("top level disturbed by a child insert: %v", got)
	}
}

// TestItemFlagged covers the flag as the deliberately invariant-free field it
// is: settable on anything, orthogonal to nesting, untouched by unrelated
// patches, and readable through the full-roadmap path the UI uses.
func TestItemFlagged(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane, _ := testStore.CreateLane(ctx, rm.ID, "L")
	parent, err := testStore.CreateItem(ctx, lane.ID, NewItem{
		Title: "Parent", StartDate: date("2026-01-01"), EndDate: date("2026-02-01"),
	})
	if err != nil {
		t.Fatal(err)
	}
	child, err := testStore.CreateItem(ctx, lane.ID, NewItem{
		Title: "Child", StartDate: date("2026-01-05"), EndDate: date("2026-01-10"), ParentID: &parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	// New items are unflagged.
	if parent.Flagged || child.Flagged {
		t.Errorf("new items flagged: parent=%v child=%v", parent.Flagged, child.Flagged)
	}

	// A child can be flagged without its parent: a problem lives in one item,
	// so the flag deliberately does not propagate either way.
	upd, err := testStore.UpdateItem(ctx, child.ID, ItemPatch{
		Flagged: model.Opt[bool]{Set: true, Value: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !upd.Flagged {
		t.Error("child not flagged after patch")
	}

	// An unrelated patch leaves the flag alone.
	upd2, err := testStore.UpdateItem(ctx, child.ID, ItemPatch{
		Title: model.Opt[string]{Set: true, Value: "Child2"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !upd2.Flagged {
		t.Error("flag lost across an unrelated patch")
	}

	// The flag survives the full-roadmap read path, and stayed off the parent.
	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	gp := full.Lanes[0].Items[0]
	if gp.Flagged {
		t.Error("flag leaked from child to parent")
	}
	if len(gp.Children) != 1 || !gp.Children[0].Flagged {
		t.Errorf("child flag from GetRoadmapFull: %+v", gp.Children)
	}

	// Explicitly clearing it.
	upd3, err := testStore.UpdateItem(ctx, child.ID, ItemPatch{
		Flagged: model.Opt[bool]{Set: true, Value: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	if upd3.Flagged {
		t.Error("flag not cleared")
	}
}

// TestItemPlanningSignals covers tentative and at_risk the way TestItemFlagged
// covers the flag: invariant-free booleans, independent of each other, of the
// flag, and of nesting, untouched by unrelated patches, and readable through
// the full-roadmap path.
func TestItemPlanningSignals(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane, _ := testStore.CreateLane(ctx, rm.ID, "L")
	parent, err := testStore.CreateItem(ctx, lane.ID, NewItem{
		Title: "Parent", StartDate: date("2026-01-01"), EndDate: date("2026-02-01"),
	})
	if err != nil {
		t.Fatal(err)
	}
	child, err := testStore.CreateItem(ctx, lane.ID, NewItem{
		Title: "Child", StartDate: date("2026-01-05"), EndDate: date("2026-01-10"), ParentID: &parent.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	// New items carry neither signal.
	if parent.Tentative || parent.AtRisk || child.Tentative || child.AtRisk {
		t.Errorf("new items carry signals: parent=%+v child=%+v", parent, child)
	}

	// Both signals plus the flag on one item: they coexist by design, and none
	// propagates between parent and child.
	upd, err := testStore.UpdateItem(ctx, child.ID, ItemPatch{
		Tentative: model.Opt[bool]{Set: true, Value: true},
		AtRisk:    model.Opt[bool]{Set: true, Value: true},
		Flagged:   model.Opt[bool]{Set: true, Value: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !upd.Tentative || !upd.AtRisk || !upd.Flagged {
		t.Errorf("signals not set after patch: %+v", upd)
	}

	// An unrelated patch leaves both alone.
	upd2, err := testStore.UpdateItem(ctx, child.ID, ItemPatch{
		Title: model.Opt[string]{Set: true, Value: "Child2"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !upd2.Tentative || !upd2.AtRisk {
		t.Error("signals lost across an unrelated patch")
	}

	// Full-roadmap read path; nothing leaked to the parent.
	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	gp := full.Lanes[0].Items[0]
	if gp.Tentative || gp.AtRisk {
		t.Error("signals leaked from child to parent")
	}
	if len(gp.Children) != 1 || !gp.Children[0].Tentative || !gp.Children[0].AtRisk {
		t.Errorf("child signals from GetRoadmapFull: %+v", gp.Children)
	}

	// Each clears independently of the other.
	upd3, err := testStore.UpdateItem(ctx, child.ID, ItemPatch{
		Tentative: model.Opt[bool]{Set: true, Value: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	if upd3.Tentative || !upd3.AtRisk {
		t.Errorf("clearing tentative: %+v", upd3)
	}
}

func TestMilestones(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane, _ := testStore.CreateLane(ctx, rm.ID, "L")

	m, err := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{
		Title: "GA launch", Description: "Public release", Date: date("2026-06-01"), Tentative: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if m.Title != "GA launch" || !m.Date.Equal(date("2026-06-01").Time) || m.LaneID != lane.ID || !m.Tentative {
		t.Errorf("create result: %+v", m)
	}

	// Validation: empty title, missing date, missing lane.
	if _, err := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{Date: date("2026-06-01")}); !isValidation(err) {
		t.Errorf("empty title: want validation error, got %v", err)
	}
	if _, err := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{Title: "X"}); !isValidation(err) {
		t.Errorf("missing date: want validation error, got %v", err)
	}
	if _, err := testStore.CreateMilestone(ctx, -1, NewMilestone{Title: "X", Date: date("2026-06-01")}); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing lane: want ErrNotFound, got %v", err)
	}

	// Partial update leaves other fields intact.
	upd, err := testStore.UpdateMilestone(ctx, m.ID, MilestonePatch{
		Date: model.Opt[model.Date]{Set: true, Value: date("2026-07-15")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if upd.Title != "GA launch" || !upd.Date.Equal(date("2026-07-15").Time) || !upd.Tentative {
		t.Errorf("update result: %+v", upd)
	}
	upd, err = testStore.UpdateMilestone(ctx, m.ID, MilestonePatch{
		Tentative: model.Opt[bool]{Set: true, Value: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	if upd.Tentative {
		t.Errorf("clearing tentative: %+v", upd)
	}
	if _, err := testStore.UpdateMilestone(ctx, m.ID, MilestonePatch{
		Title: model.Opt[string]{Set: true, Value: ""},
	}); !isValidation(err) {
		t.Errorf("empty title update: want validation error, got %v", err)
	}
	if _, err := testStore.UpdateMilestone(ctx, -1, MilestonePatch{
		Title: model.Opt[string]{Set: true, Value: "X"},
	}); !errors.Is(err, ErrNotFound) {
		t.Errorf("update missing milestone: want ErrNotFound, got %v", err)
	}

	// Milestones appear in the full roadmap, ordered by date, attached to the lane.
	m2, _ := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{Title: "Beta", Date: date("2026-03-01")})
	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	ms := full.Lanes[0].Milestones
	if len(ms) != 2 || ms[0].ID != m2.ID || ms[1].ID != m.ID {
		t.Errorf("milestones order: %+v", ms)
	}

	if err := testStore.DeleteMilestone(ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if err := testStore.DeleteMilestone(ctx, m.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("delete missing: want ErrNotFound, got %v", err)
	}

	// Deleting the lane cascades to its milestones.
	if err := testStore.DeleteLane(ctx, lane.ID); err != nil {
		t.Fatal(err)
	}
	if err := testStore.DeleteMilestone(ctx, m2.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("cascade delete: want ErrNotFound, got %v", err)
	}
}

func TestImportRoadmap(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)

	lane1, _ := testStore.CreateLane(ctx, rm.ID, "L1")
	lane2, _ := testStore.CreateLane(ctx, rm.ID, "L2")
	parent, err := testStore.CreateItem(ctx, lane1.ID, NewItem{
		Title: "Parent", StartDate: date("2026-01-01"), EndDate: date("2026-02-01")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateItem(ctx, lane1.ID, NewItem{
		Title: "Child", StartDate: date("2026-01-05"), EndDate: date("2026-01-10"), ParentID: &parent.ID}); err != nil {
		t.Fatal(err)
	}
	p3 := 3
	if _, err := testStore.UpdateItem(ctx, parent.ID, ItemPatch{
		Priority:  model.Opt[*int]{Set: true, Value: &p3},
		Labels:    model.Opt[[]string]{Set: true, Value: []string{"alpha", "beta"}},
		Flagged:   model.Opt[bool]{Set: true, Value: true},
		Tentative: model.Opt[bool]{Set: true, Value: true},
		AtRisk:    model.Opt[bool]{Set: true, Value: true}}); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateMilestone(ctx, lane2.ID, NewMilestone{
		Title: "Launch", Date: date("2026-03-01"), Tentative: true}); err != nil {
		t.Fatal(err)
	}

	src, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}

	imported, err := testStore.ImportRoadmap(ctx, src, Ownership{}, ImportCopy)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), imported.ID) })

	// Same name already exists, so the import must be disambiguated.
	if imported.Name != src.Name+" (2)" {
		t.Errorf("import name: want %q, got %q", src.Name+" (2)", imported.Name)
	}
	// Fresh roadmap ID.
	if imported.ID == rm.ID {
		t.Errorf("import reused source roadmap ID")
	}

	got, err := testStore.GetRoadmapFull(ctx, imported.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Lanes) != 2 {
		t.Fatalf("lanes: want 2, got %d", len(got.Lanes))
	}
	gl1, gl2 := got.Lanes[0], got.Lanes[1]
	if gl1.Name != "L1" || gl2.Name != "L2" {
		t.Errorf("lane names/order: %q, %q", gl1.Name, gl2.Name)
	}
	if gl1.Color != lane1.Color || gl2.Color != lane2.Color {
		t.Errorf("lane colors not preserved: %q/%q vs %q/%q", gl1.Color, gl2.Color, lane1.Color, lane2.Color)
	}
	// All IDs must be reassigned.
	if gl1.ID == lane1.ID {
		t.Errorf("import reused source lane ID")
	}
	if len(gl1.Items) != 1 || len(gl1.Items[0].Children) != 1 {
		t.Fatalf("item hierarchy not preserved: %+v", gl1.Items)
	}
	gp := gl1.Items[0]
	if gp.Title != "Parent" || gp.ID == parent.ID {
		t.Errorf("parent item: title=%q id=%d", gp.Title, gp.ID)
	}
	if gp.Priority == nil || *gp.Priority != 3 {
		t.Errorf("priority not preserved: %v", gp.Priority)
	}
	if len(gp.Labels) != 2 || gp.Labels[0] != "alpha" || gp.Labels[1] != "beta" {
		t.Errorf("labels not preserved: %v", gp.Labels)
	}
	// The flag and both planning signals ride in the export envelope, so they
	// must survive import — and therefore snapshot restore, which uses the
	// same insert path.
	if !gp.Flagged {
		t.Error("flagged not preserved through import")
	}
	if !gp.Tentative || !gp.AtRisk {
		t.Errorf("planning signals not preserved through import: tentative=%v atRisk=%v",
			gp.Tentative, gp.AtRisk)
	}
	gc := gl1.Items[0].Children[0]
	if gc.Title != "Child" || gc.ParentID == nil || *gc.ParentID != gp.ID {
		t.Errorf("child linkage: title=%q parent=%v", gc.Title, gc.ParentID)
	}
	if gc.LaneID != gl1.ID {
		t.Errorf("child lane: want %d, got %d", gl1.ID, gc.LaneID)
	}
	if len(gl2.Milestones) != 1 || gl2.Milestones[0].Title != "Launch" || !gl2.Milestones[0].Tentative {
		t.Errorf("milestones not preserved: %+v", gl2.Milestones)
	}

	// Empty name is rejected.
	if _, err := testStore.ImportRoadmap(ctx, model.RoadmapFull{}, Ownership{}, ImportCopy); !isValidation(err) {
		t.Errorf("empty name: want validation error, got %v", err)
	}
}

// TestSchemaMatchesMigrations guards against schema.sql drifting from the
// migrations: it builds the schema both ways in a throwaway namespace and
// compares the resulting tables/columns. Both builds are rolled back.
func TestSchemaMatchesMigrations(t *testing.T) {
	ctx := context.Background()

	migs, err := migrationEntries()
	if err != nil {
		t.Fatal(err)
	}

	fromMigrations := describeBuild(t, func(tx pgx.Tx) error {
		for _, m := range migs {
			sql, err := migrationFS.ReadFile("migrations/" + m.name)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, string(sql)); err != nil {
				return fmt.Errorf("migration %s: %w", m.name, err)
			}
		}
		return nil
	})
	fromSchema := describeBuild(t, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, schemaSQL)
		return err
	})

	if !reflect.DeepEqual(fromMigrations, fromSchema) {
		t.Errorf("schema.sql and migrations diverge\n  from migrations: %v\n  from schema.sql: %v",
			fromMigrations, fromSchema)
	}
}

// describeBuild runs build in an isolated, rolled-back schema and returns a
// "table.column -> datatype|nullable" description of the tables it created.
func describeBuild(t *testing.T, build func(pgx.Tx) error) map[string]string {
	t.Helper()
	ctx := context.Background()
	const ns = "roadie_schema_check"

	tx, err := testStore.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DROP SCHEMA IF EXISTS `+ns+` CASCADE`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `CREATE SCHEMA `+ns); err != nil {
		t.Fatal(err)
	}
	// New tables (and unqualified FK/index references) resolve into ns.
	if _, err := tx.Exec(ctx, `SET LOCAL search_path TO `+ns); err != nil {
		t.Fatal(err)
	}
	if err := build(tx); err != nil {
		t.Fatal(err)
	}

	rows, err := tx.Query(ctx,
		`SELECT table_name, column_name, data_type, is_nullable
		 FROM information_schema.columns WHERE table_schema = $1`, ns)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	desc := map[string]string{}
	for rows.Next() {
		var table, col, typ, nullable string
		if err := rows.Scan(&table, &col, &typ, &nullable); err != nil {
			t.Fatal(err)
		}
		desc[table+"."+col] = typ + "|" + nullable
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return desc
}

func TestCheckNoPrunedGap(t *testing.T) {
	migsFrom := func(vs ...int) []migration {
		out := make([]migration, len(vs))
		for i, v := range vs {
			out[i] = migration{version: v, name: fmt.Sprintf("%03d_x.sql", v)}
		}
		return out
	}
	appliedSet := func(vs ...int) map[int]bool {
		m := map[int]bool{}
		for _, v := range vs {
			m[v] = true
		}
		return m
	}

	cases := []struct {
		name    string
		applied []int
		migs    []int
		wantErr bool
	}{
		{"fully migrated, files pruned", []int{1, 2, 3, 4, 5, 6}, []int{4, 5, 6}, false},
		{"at last pruned version", []int{1, 2, 3, 4}, []int{5, 6}, false},
		{"normal pending, no pruning", []int{1, 2, 3}, []int{1, 2, 3, 4, 5, 6}, false},
		{"too old after pruning", []int{1, 2}, []int{5, 6}, true},
		{"one past the gap", []int{1, 2, 3}, []int{5, 6}, true},
		{"nothing applied yet, all present", []int{}, []int{1, 2, 3}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkNoPrunedGap(appliedSet(tc.applied...), migsFrom(tc.migs...))
			if tc.wantErr != (err != nil) {
				t.Errorf("checkNoPrunedGap: wantErr=%v, got %v", tc.wantErr, err)
			}
		})
	}
}

// hasRoadmap reports whether a roadmap listing contains id.
func hasRoadmap(list []model.Roadmap, id int64) bool {
	return slices.ContainsFunc(list, func(r model.Roadmap) bool { return r.ID == id })
}

// TestRoadmapTrash covers the whole soft-delete round trip: a trashed roadmap
// disappears from the API, freezes, and comes back whole — including the
// snapshot history a real delete would have cascaded away.
func TestRoadmapTrash(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane, err := testStore.CreateLane(ctx, rm.ID, "Lane")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateItem(ctx, lane.ID, NewItem{
		Title: "Item", StartDate: date("2026-01-01"), EndDate: date("2026-02-01")}); err != nil {
		t.Fatal(err)
	}
	ms, err := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{
		Title: "Launch", Date: date("2026-03-01")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.CreateSnapshot(ctx, rm.ID, model.SnapshotManual, strPtr("checkpoint")); err != nil {
		t.Fatal(err)
	}

	if err := testStore.TrashRoadmap(ctx, rm.ID); err != nil {
		t.Fatal(err)
	}

	live, err := testStore.ListRoadmaps(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if hasRoadmap(live, rm.ID) {
		t.Error("trashed roadmap still listed as live")
	}
	trashed, err := testStore.ListTrashedRoadmaps(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(trashed, func(r model.Roadmap) bool { return r.ID == rm.ID })
	if i < 0 {
		t.Fatal("trashed roadmap missing from the trash")
	}
	if trashed[i].DeletedAt == nil {
		t.Error("trashed roadmap has no deletion time")
	}

	// Invisible: reading it is indistinguishable from it not existing.
	if _, err := testStore.GetRoadmapFull(ctx, rm.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetRoadmapFull on trashed roadmap: got %v, want ErrNotFound", err)
	}
	if _, err := testStore.RenameRoadmap(ctx, rm.ID, "renamed"); !errors.Is(err, ErrNotFound) {
		t.Errorf("RenameRoadmap on trashed roadmap: got %v, want ErrNotFound", err)
	}
	if err := testStore.TrashRoadmap(ctx, rm.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("trashing twice: got %v, want ErrNotFound", err)
	}

	// Frozen: every content mutation goes through lockRoadmap, by roadmap id or
	// by lane/item id, and all of them stop here.
	if _, err := testStore.CreateLane(ctx, rm.ID, "Another"); !errors.Is(err, ErrNotFound) {
		t.Errorf("CreateLane in trashed roadmap: got %v, want ErrNotFound", err)
	}
	if _, err := testStore.CreateItem(ctx, lane.ID, NewItem{
		Title: "Sneaky", StartDate: date("2026-01-01"), EndDate: date("2026-01-02")},
	); !errors.Is(err, ErrNotFound) {
		t.Errorf("CreateItem in trashed roadmap: got %v, want ErrNotFound", err)
	}
	// Milestones included: they are the mutations that used to write straight
	// through the pool, so they neither took the lock nor saw this clause.
	if _, err := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{
		Title: "Sneaky", Date: date("2026-01-01")}); !errors.Is(err, ErrNotFound) {
		t.Errorf("CreateMilestone in trashed roadmap: got %v, want ErrNotFound", err)
	}
	if _, err := testStore.UpdateMilestone(ctx, ms.ID, MilestonePatch{
		Title: model.Opt[string]{Set: true, Value: "Sneaky"}}); !errors.Is(err, ErrNotFound) {
		t.Errorf("UpdateMilestone in trashed roadmap: got %v, want ErrNotFound", err)
	}
	if err := testStore.DeleteMilestone(ctx, ms.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("DeleteMilestone in trashed roadmap: got %v, want ErrNotFound", err)
	}

	back, err := testStore.RestoreRoadmap(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if back.DeletedAt != nil {
		t.Error("restored roadmap still carries a deletion time")
	}
	if _, err := testStore.RestoreRoadmap(ctx, rm.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("restoring twice: got %v, want ErrNotFound", err)
	}

	full, err := testStore.GetRoadmapFull(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Lanes) != 1 || len(full.Lanes[0].Items) != 1 {
		t.Errorf("restored roadmap: got %d lanes / %d items, want 1 / 1",
			len(full.Lanes), len(full.Lanes[0].Items))
	}
	snaps, err := testStore.ListSnapshots(ctx, rm.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snaps) == 0 {
		t.Error("restored roadmap lost its snapshot history")
	}
}

// TestPurgeRoadmapRequiresTrash pins the two-step rule: the only irreversible
// operation in the product refuses to run on a roadmap that is still live.
func TestPurgeRoadmapRequiresTrash(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)

	if err := testStore.PurgeRoadmap(ctx, rm.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("purging a live roadmap: got %v, want ErrNotFound", err)
	}
	if _, err := testStore.GetRoadmapFull(ctx, rm.ID); err != nil {
		t.Fatalf("live roadmap damaged by a refused purge: %v", err)
	}

	if err := testStore.TrashRoadmap(ctx, rm.ID); err != nil {
		t.Fatal(err)
	}
	if err := testStore.PurgeRoadmap(ctx, rm.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := testStore.GetRoadmapFull(ctx, rm.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("purged roadmap still readable: %v", err)
	}
	trashed, err := testStore.ListTrashedRoadmaps(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if hasRoadmap(trashed, rm.ID) {
		t.Error("purged roadmap still in the trash")
	}
}

func TestPurgeExpiredTrash(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	if err := testStore.TrashRoadmap(ctx, rm.ID); err != nil {
		t.Fatal(err)
	}

	// A fresh delete is well inside its retention window.
	if _, err := testStore.PurgeExpiredTrash(ctx, 24*time.Hour); err != nil {
		t.Fatal(err)
	}
	trashed, err := testStore.ListTrashedRoadmaps(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if !hasRoadmap(trashed, rm.ID) {
		t.Fatal("sweep purged a roadmap deleted moments ago")
	}

	// Age it past any plausible retention window, and sweep with one to match:
	// the assertion is about this roadmap, and a ttl this long can't take
	// anything else in the database with it.
	if _, err := testStore.pool.Exec(ctx,
		`UPDATE roadmaps SET deleted_at = now() - interval '400 days' WHERE id = $1`, rm.ID); err != nil {
		t.Fatal(err)
	}
	n, err := testStore.PurgeExpiredTrash(ctx, 365*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if n < 1 {
		t.Errorf("sweep purged %d roadmaps, want at least 1", n)
	}
	if _, err := testStore.GetRoadmapFull(ctx, rm.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("expired roadmap survived the sweep: %v", err)
	}
}
