package sheet

import (
	"bytes"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

// scheduleWithHoles is the awkward schedule the timeline still has to cover:
// it starts after the work does, has an interior gap, and stops before the work
// ends.
func scheduleWithHoles() model.RoadmapFull {
	return model.RoadmapFull{
		Lanes: []model.LaneFull{lane("Backend", "blue", items(
			item(1, "Early", "2026-01-05", "2026-01-20"),      // before the schedule
			item(2, "In the gap", "2026-03-05", "2026-03-10"), // inside the hole
			item(3, "Late", "2026-05-01", "2026-05-20"),       // after the schedule
		))},
		Periods: []model.SchedulePeriod{
			period("PI 1", "2026-02-01", "2026-02-28"),
			// March 1..31 is a gap.
			period("PI 2", "2026-04-01", "2026-04-15"),
		},
	}
}

func TestPeriodColumnsBoundedByStarts(t *testing.T) {
	cols, unit := timelineColumns(scheduleWithHoles())
	if unit != unitPeriods {
		t.Fatalf("unit = %q, want %q", unit, unitPeriods)
	}
	want := []struct{ label, from, to string }{
		// The first column stretches back over the work that precedes the
		// schedule, and swallows the March gap up to the next period's start.
		{"PI 1", "2026-01-05", "2026-03-31"},
		// The last stretches forward over everything past the schedule.
		{"PI 2", "2026-04-01", "2026-05-20"},
	}
	if len(cols) != len(want) {
		t.Fatalf("columns = %d, want %d: %+v", len(cols), len(want), cols)
	}
	for i, w := range want {
		if cols[i].label != w.label || cols[i].from != dayOf(date(w.from)) || cols[i].to != dayOf(date(w.to)) {
			t.Errorf("column %d = %q %s..%s, want %q %s..%s", i, cols[i].label,
				dateOf(cols[i].from).Format("2006-01-02"), dateOf(cols[i].to).Format("2006-01-02"),
				w.label, w.from, w.to)
		}
	}
}

// The grid must partition the content: every day between the first and the
// last is in exactly one column, so a blank cell means "no work here" rather
// than "no column here".
func TestTimelineCoversContentWithoutHoles(t *testing.T) {
	rm := scheduleWithHoles()
	cols, _ := timelineColumns(rm)
	from, to, ok := contentRange(rm)
	if !ok {
		t.Fatal("content range is empty")
	}
	if cols[0].from != from || cols[len(cols)-1].to != to {
		t.Errorf("columns span %d..%d, want %d..%d", cols[0].from, cols[len(cols)-1].to, from, to)
	}
	for i := 1; i < len(cols); i++ {
		if cols[i].from != cols[i-1].to+1 {
			t.Errorf("hole or overlap between column %d and %d", i-1, i)
		}
	}
	// And every item lands somewhere, including the one lying entirely in the
	// schedule's own gap.
	for _, it := range rm.Lanes[0].Items {
		marked := false
		for _, c := range cols {
			if c.overlap(dayOf(it.StartDate), dayOf(it.EndDate)) > 0 {
				marked = true
			}
		}
		if !marked {
			t.Errorf("item %q is in no column", it.Title)
		}
	}
}

// The schedule can lie entirely beyond the work; the first period still names
// the one column that carries it.
func TestPeriodColumnsWhenWorkPrecedesTheSchedule(t *testing.T) {
	rm := model.RoadmapFull{
		Lanes:   []model.LaneFull{lane("Backend", "blue", items(item(1, "Now", "2026-01-01", "2026-01-31")))},
		Periods: []model.SchedulePeriod{period("PI 9", "2027-01-01", "2027-01-31")},
	}
	cols, _ := timelineColumns(rm)
	if len(cols) != 1 || cols[0].label != "PI 9" ||
		cols[0].from != dayOf(date("2026-01-01")) || cols[0].to != dayOf(date("2026-01-31")) {
		t.Errorf("columns = %+v", cols)
	}
}

func TestCalendarColumnsExtendToWholeUnits(t *testing.T) {
	rm := model.RoadmapFull{Lanes: []model.LaneFull{
		lane("Backend", "blue", items(item(1, "Work", "2026-01-20", "2026-03-05"))),
	}}
	cols, unit := timelineColumns(rm)
	if unit != unitMonths {
		t.Fatalf("unit = %q, want %q", unit, unitMonths)
	}
	want := []string{"Jan 2026", "Feb 2026", "Mar 2026"}
	if len(cols) != len(want) {
		t.Fatalf("columns = %+v, want %v", cols, want)
	}
	for i, w := range want {
		if cols[i].label != w {
			t.Errorf("column %d = %q, want %q", i, cols[i].label, w)
		}
	}
	if cols[0].from != dayOf(date("2026-01-01")) || cols[2].to != dayOf(date("2026-03-31")) {
		t.Errorf("extent = %+v, want whole months", cols)
	}
}

// Past maxCalendarColumns the calendar axis coarsens rather than growing a
// column per month across a decade.
func TestLongRoadmapFallsBackToQuarters(t *testing.T) {
	rm := model.RoadmapFull{Lanes: []model.LaneFull{
		lane("Backend", "blue", items(item(1, "Epic", "2026-01-01", "2031-12-31"))),
	}}
	cols, unit := timelineColumns(rm)
	if unit != unitQuarters {
		t.Fatalf("unit = %q, want %q", unit, unitQuarters)
	}
	if len(cols) != 24 || cols[0].label != "Q1 2026" || cols[23].label != "Q4 2031" {
		t.Errorf("columns = %d, first %q last %q", len(cols), cols[0].label, cols[len(cols)-1].label)
	}
}

// Years are the last grain and are taken however many there are, which is what
// keeps the axis inside Excel's 16,384 columns. A mistyped year is enough to
// ask for a column per quarter of two millennia, and without a floor the export
// fails for the whole roadmap over one bad date.
func TestVeryLongRoadmapFallsBackToYears(t *testing.T) {
	rm := model.RoadmapFull{Lanes: []model.LaneFull{
		lane("Backend", "blue", items(item(1, "Typo", "0226-01-01", "2026-12-31"))),
	}}
	cols, unit := timelineColumns(rm)
	if unit != unitYears {
		t.Fatalf("unit = %q, want %q", unit, unitYears)
	}
	if len(cols) != 1801 || cols[0].label != "226" || cols[len(cols)-1].label != "2026" {
		t.Errorf("columns = %d, first %q last %q", len(cols), cols[0].label, cols[len(cols)-1].label)
	}
}

// The widest span the model can express still addresses a column Excel has.
// Dates parse as years 1..9999, so a year grain can never ask for more.
func TestWidestPossibleSpanStillExports(t *testing.T) {
	rm := model.RoadmapFull{Lanes: []model.LaneFull{
		lane("Backend", "blue", items(item(1, "All of time", "0001-01-01", "9999-12-31"))),
	}}
	cols, unit := timelineColumns(rm)
	if unit != unitYears || len(cols) != 9999 {
		t.Fatalf("columns = %d, unit = %q", len(cols), unit)
	}
	if last := colTimeline + len(cols) - 1; last > 16384 {
		t.Errorf("last column = %d, past Excel's 16384", last)
	}
	var buf bytes.Buffer
	if err := Write(&buf, rm, Options{}); err != nil {
		t.Errorf("Write: %v", err)
	}
}

func TestNoDatedContentMeansNoTimeline(t *testing.T) {
	cols, unit := timelineColumns(model.RoadmapFull{Lanes: []model.LaneFull{lane("Empty", "blue")}})
	if len(cols) != 0 || unit != unitNone {
		t.Errorf("columns = %+v, unit = %q", cols, unit)
	}
}

// Periods extend beyond the work, but the timeline is the work's extent: an
// empty tail of columns says nothing about it.
func TestScheduleDoesNotExtendTheContentRange(t *testing.T) {
	rm := model.RoadmapFull{
		Lanes:   []model.LaneFull{lane("Backend", "blue", items(item(1, "Work", "2026-02-01", "2026-02-10")))},
		Periods: []model.SchedulePeriod{period("PI 1", "2026-01-01", "2026-06-30")},
	}
	cols, _ := timelineColumns(rm)
	if len(cols) != 1 || cols[0].to != dayOf(date("2026-02-10")) {
		t.Errorf("columns = %+v", cols)
	}
}

// H and I name the period a date falls *inside*; a gap or the space outside the
// schedule names none.
func TestPeriodContainingIsContainmentNotEdges(t *testing.T) {
	periods := []model.SchedulePeriod{
		period("PI 1", "2026-02-01", "2026-02-28"),
		period("PI 2", "2026-04-01", "2026-04-15"),
	}
	for _, tc := range []struct{ on, want string }{
		{"2026-02-01", "PI 1"}, // flush with the start
		{"2026-02-14", "PI 1"}, // inside, and unmarked as such
		{"2026-03-15", ""},     // the gap
		{"2026-01-01", ""},     // before the schedule
		{"2026-05-01", ""},     // after it
	} {
		if got := periodContaining(periods, date(tc.on)); got != tc.want {
			t.Errorf("periodContaining(%s) = %q, want %q", tc.on, got, tc.want)
		}
	}
}
