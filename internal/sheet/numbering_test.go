package sheet

import (
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

func TestContextLabelCountsPastZ(t *testing.T) {
	for _, tc := range []struct {
		n    int
		want string
	}{{0, "A"}, {25, "Z"}, {26, "AA"}, {27, "AB"}, {51, "AZ"}, {52, "BA"}, {701, "ZZ"}, {702, "AAA"}} {
		if got := contextLabel(tc.n); got != tc.want {
			t.Errorf("contextLabel(%d) = %q, want %q", tc.n, got, tc.want)
		}
	}
}

func TestEntityLabels(t *testing.T) {
	if got := entityLabel("B", 1); got != "B.1" {
		t.Errorf("entityLabel = %q", got)
	}
	if got := childLabel(entityLabel("B", 3), 1); got != "B.3.2" {
		t.Errorf("childLabel = %q", got)
	}
}

// Numbering is positional over the contexts, so an empty one still consumes its
// letter — the next context is C, not B.
func TestEmptyContextStillTakesItsLetter(t *testing.T) {
	rm := model.RoadmapFull{Lanes: []model.LaneFull{
		lane("Backend", "blue", items(item(1, "One", "2026-01-01", "2026-01-10"))),
		lane("Empty", "green"),
		lane("Frontend", "red", items(item(2, "Two", "2026-01-01", "2026-01-10"))),
	}}
	got := []string{}
	for _, r := range buildRows(rm) {
		got = append(got, r.wbs)
	}
	want := []string{"A.1", "C.1"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("wbs numbers = %v, want %v", got, want)
	}
}

// Canonical order: contexts by position, milestones before items, each parent's
// children directly after it.
func TestRowOrderIsCanonical(t *testing.T) {
	parent := item(1, "Parent", "2026-01-01", "2026-03-01")
	parent.Children = []model.Item{
		mustItem(2, "Child A", "2026-01-01", "2026-01-20"),
		mustItem(3, "Child B", "2026-02-01", "2026-02-20"),
	}
	rm := model.RoadmapFull{Lanes: []model.LaneFull{{
		Lane:       model.Lane{ID: 1, Name: "Backend", Color: "blue"},
		Items:      []model.ItemFull{parent, item(4, "Next", "2026-01-01", "2026-01-10")},
		Milestones: []model.Milestone{milestone(5, "Launch", "2026-03-01")},
	}}}
	var got []string
	for _, r := range buildRows(rm) {
		got = append(got, r.wbs+" "+r.title)
	}
	// Milestones and items share one sequence, so the milestone takes A.1 and
	// the first item follows it at A.2.
	want := []string{"A.1 Launch", "A.2 Parent", "A.2.1 Child A", "A.2.2 Child B", "A.3 Next"}
	for i := range want {
		if i >= len(got) || got[i] != want[i] {
			t.Fatalf("rows = %v, want %v", got, want)
		}
	}
}
