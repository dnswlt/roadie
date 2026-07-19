package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

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
	rm, err := testStore.CreateRoadmap(ctx, "test-"+t.Name())
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
	if _, err := testStore.CreateRoadmap(ctx, ""); !isValidation(err) {
		t.Errorf("empty name: want validation error, got %v", err)
	}
	list, err := testStore.ListRoadmaps(ctx)
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

func TestMilestones(t *testing.T) {
	ctx := context.Background()
	rm := newRoadmap(t)
	lane, _ := testStore.CreateLane(ctx, rm.ID, "L")

	m, err := testStore.CreateMilestone(ctx, lane.ID, NewMilestone{
		Title: "GA launch", Description: "Public release", Date: date("2026-06-01"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if m.Title != "GA launch" || !m.Date.Equal(date("2026-06-01").Time) || m.LaneID != lane.ID {
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
	if upd.Title != "GA launch" || !upd.Date.Equal(date("2026-07-15").Time) {
		t.Errorf("update result: %+v", upd)
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
