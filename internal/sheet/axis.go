package sheet

import (
	"fmt"
	"strconv"

	"github.com/dnswlt/roadie/internal/model"
)

// column is one cell of the timeline grid: a heading and the inclusive day
// range it stands for. The ranges partition the content exactly — every day
// between the first and the last is in one column and no other — which is what
// lets a reader trust a blank cell.
type column struct {
	label    string
	from, to int
}

func (c column) days() int { return c.to - c.from + 1 }

// overlap is how much of an inclusive span falls in the column, in days.
func (c column) overlap(from, to int) int {
	lo, hi := max(from, c.from), min(to, c.to)
	if lo > hi {
		return 0
	}
	return hi - lo + 1
}

// timelineUnit names what a timeline column stands for, for the Info sheet.
type timelineUnit string

const (
	unitPeriods  timelineUnit = "Schedule periods"
	unitMonths   timelineUnit = "Months"
	unitQuarters timelineUnit = "Quarters"
	unitYears    timelineUnit = "Years"
	unitNone     timelineUnit = "None (no dated content)"
)

// maxCalendarColumns is where one calendar grain gives way to the next. Past it
// the grid stops being readable across a screen, and a roadmap that long is
// being read at the coarser grain anyway.
const maxCalendarColumns = 48

// calendarGrains are tried in order, the first one that fits winning. Years are
// the last and are taken whatever their count, which is also what bounds the
// sheet: model dates run from year 1 to year 9999, so a year axis can never
// exceed 9999 columns, well inside Excel's 16,384. Without that floor the axis
// is unbounded — a single mistyped year is enough to ask for a column per
// quarter of two millennia.
var calendarGrains = []struct {
	unit  timelineUnit
	start func(day, offset int) int
	label func(day int) string
}{
	{unitMonths, monthStart, monthLabel},
	{unitQuarters, quarterStart, quarterLabel},
	{unitYears, yearStart, yearLabel},
}

// timelineColumns lays out the grid to the right of the table.
//
// With a schedule there is one column per period, bounded by period *start*
// dates: a column runs to the next period's start, so a gap between two periods
// belongs to the period before it, and the first and last stretch to the ends
// of the content. Without one the axis falls back to the calendar. Either way
// the columns cover exactly the span the work occupies — no padding to today,
// no empty tail.
func timelineColumns(rm model.RoadmapFull) ([]column, timelineUnit) {
	from, to, ok := contentRange(rm)
	if !ok {
		return nil, unitNone
	}
	if len(rm.Periods) > 0 {
		return periodColumns(rm.Periods, from, to), unitPeriods
	}
	coarsest := len(calendarGrains) - 1
	for _, grain := range calendarGrains[:coarsest] {
		if cols := calendarColumns(from, to, grain.start, grain.label); len(cols) <= maxCalendarColumns {
			return cols, grain.unit
		}
	}
	years := calendarGrains[coarsest]
	return calendarColumns(from, to, years.start, years.label), years.unit
}

// contentRange is the span items and milestones occupy. Schedule periods do not
// extend it: an empty tail of columns says nothing about the work.
func contentRange(rm model.RoadmapFull) (from, to int, ok bool) {
	cover := func(a, b int) {
		if !ok {
			from, to, ok = a, b, true
			return
		}
		from, to = min(from, a), max(to, b)
	}
	for _, lane := range rm.Lanes {
		for _, item := range lane.Items {
			cover(dayOf(item.StartDate), dayOf(item.EndDate))
			// Children can extend past their parent, so they count too.
			for _, c := range item.Children {
				cover(dayOf(c.StartDate), dayOf(c.EndDate))
			}
		}
		for _, ms := range lane.Milestones {
			cover(dayOf(ms.Date), dayOf(ms.Date))
		}
	}
	return from, to, ok
}

// periodColumns cuts [from, to] at the period start dates. Periods arrive
// sorted by start date and cannot overlap (the store rejects that).
func periodColumns(periods []model.SchedulePeriod, from, to int) []column {
	var cols []column
	for i, p := range periods {
		start := max(dayOf(p.StartDate), from)
		end := to
		if i+1 < len(periods) {
			end = min(dayOf(periods[i+1].StartDate)-1, to)
		}
		if start > end {
			continue
		}
		cols = append(cols, column{label: p.Label, from: start, to: end})
	}
	if len(cols) == 0 {
		// The whole roadmap lies before the schedule starts; the first period
		// still names the column that carries it.
		return []column{{label: periods[0].Label, from: from, to: to}}
	}
	// Content outside the schedule joins the nearest column rather than falling
	// through a hole.
	cols[0].from = from
	cols[len(cols)-1].to = to
	return cols
}

// calendarColumns tiles [from, to] with whole calendar units, extending the
// extent outward to the unit boundaries.
func calendarColumns(from, to int, start func(day, offset int) int, label func(day int) string) []column {
	var cols []column
	for day := start(from, 0); day <= to; {
		next := start(day, 1)
		cols = append(cols, column{label: label(day), from: day, to: next - 1})
		day = next
	}
	return cols
}

func monthLabel(day int) string {
	d := dateOf(day).Time
	return fmt.Sprintf("%s %d", d.Month().String()[:3], d.Year())
}

func quarterLabel(day int) string {
	d := dateOf(day).Time
	return fmt.Sprintf("Q%d %d", (int(d.Month())-1)/3+1, d.Year())
}

func yearLabel(day int) string {
	return strconv.Itoa(dateOf(day).Time.Year())
}
