package sheet

import (
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dnswlt/roadie/internal/model"
	"github.com/xuri/excelize/v2"
)

// fullRoadmap carries one of everything a column can render.
func fullRoadmap() model.RoadmapFull {
	priority := 2
	parent := item(1, "Ship the thing", "2026-02-10", "2026-02-19")
	parent.Description = "spec at [the design](https://x.test/design), also https://y.test/notes."
	parent.Priority = &priority
	parent.Labels = []string{"platform", "q1"}
	parent.Tentative = true
	parent.AtRisk = true
	parent.Flagged = true
	parent.Children = []model.Item{mustItem(2, "Sub task", "2026-02-10", "2026-02-14")}

	launch := milestone(3, "Launch", "2026-02-28")
	launch.Linkage = &model.MilestoneLinkage{Integration: true}

	l := lane("Backend", "green", items(parent))
	l.Milestones = []model.Milestone{launch}
	return model.RoadmapFull{
		Roadmap: model.Roadmap{ID: 42, UID: "rm-uid-42", Name: "Platform 2026"},
		Lanes:   []model.LaneFull{l},
		Periods: []model.SchedulePeriod{
			period("PI 1", "2026-02-01", "2026-02-28"),
			period("PI 2", "2026-03-01", "2026-03-31"),
		},
	}
}

// Rows are milestone-first within a context, so the item is row 3.
const (
	rowMilestone = "2"
	rowItem      = "3"
	rowChild     = "4"
)

func TestItemRowValues(t *testing.T) {
	f := render(t, fullRoadmap(), testOptions)
	for _, tc := range []struct{ col, want string }{
		{"A", "A.2"}, // the milestone above it took A.1
		{"B", "Backend"},
		{"C", "Ship the thing"},
		{"D", "Item"},
		{"E", "2026-02-10"},
		{"F", "2026-02-19"},
		{"G", "10"},
		{"H", "PI 1"},
		{"I", "PI 1"},
		{"J", "P2"},
		{"K", "Yes"},
		{"L", "Yes"},
		{"M", "Yes"},
		{"N", "platform, q1"},
		// Two links, so the cell is plain text with one URL per line: attaching
		// a hyperlink would collapse them onto one.
		{"O", "https://x.test/design\nhttps://y.test/notes"},
		{"P", "spec at [the design](https://x.test/design), also https://y.test/notes."},
	} {
		if got := cell(t, f, sheetRoadmap, tc.col+rowItem); got != tc.want {
			t.Errorf("%s%s = %q, want %q", tc.col, rowItem, got, tc.want)
		}
	}
}

// A milestone puts its date in both ends and has no duration.
func TestMilestoneRow(t *testing.T) {
	f := render(t, fullRoadmap(), testOptions)
	for _, tc := range []struct{ col, want string }{
		{"A", "A.1"},
		{"C", "Launch"},
		// The cross-roadmap role stands in for the kind; only milestones have one.
		{"D", "Integration"},
		{"E", "2026-02-28"},
		{"F", "2026-02-28"},
		{"G", ""},
	} {
		if got := cell(t, f, sheetRoadmap, tc.col+rowMilestone); got != tc.want {
			t.Errorf("%s%s = %q, want %q", tc.col, rowMilestone, got, tc.want)
		}
	}
}

// The indent is Excel's own, not a "- " prefix that would end up inside a pivot
// label or a filter value.
func TestChildRowIsIndentedNotPrefixed(t *testing.T) {
	f := render(t, fullRoadmap(), testOptions)
	if got := cell(t, f, sheetRoadmap, "C"+rowChild); got != "Sub task" {
		t.Errorf("child name = %q", got)
	}
	if got := cell(t, f, sheetRoadmap, "D"+rowChild); got != "Sub-item" {
		t.Errorf("child type = %q", got)
	}
	st := style(t, f, sheetRoadmap, "C"+rowChild)
	if st.Alignment == nil || st.Alignment.Indent != 1 {
		t.Errorf("child name alignment = %+v, want indent 1", st.Alignment)
	}
	if parent := style(t, f, sheetRoadmap, "C"+rowItem); parent.Alignment != nil && parent.Alignment.Indent != 0 {
		t.Errorf("parent name is indented: %+v", parent.Alignment)
	}
}

// Coverage is the share of the *column* the work occupies, stored exact and
// shown as a whole percentage.
func TestTimelineCoverage(t *testing.T) {
	rm := model.RoadmapFull{
		Lanes: []model.LaneFull{lane("Backend", "blue", items(
			item(1, "Straddles both ends", "2026-01-20", "2026-03-10"), // partial, full, partial
			item(2, "One day", "2026-02-14", "2026-02-14"),
			item(3, "Exactly one column", "2026-02-01", "2026-02-28"),
		))},
	}
	f := render(t, rm, testOptions)
	// Months: Jan (31), Feb (28), Mar (31) in columns S, T, U.
	for _, tc := range []struct{ ref, want string }{
		{"S2", "39%"}, // 12 of 31 days
		{"T2", "100%"},
		{"U2", "32%"}, // 10 of 31
		{"S3", ""},    // blank at zero, not "0%"
		{"T3", "4%"},  // 1 of 28
		{"U3", ""},
		{"S4", ""},
		{"T4", "100%"},
		{"U4", ""},
	} {
		if got := cell(t, f, sheetRoadmap, tc.ref); got != tc.want {
			t.Errorf("%s = %q, want %q", tc.ref, got, tc.want)
		}
	}
	raw, err := f.GetCellValue(sheetRoadmap, "T3", excelize.Options{RawCellValue: true})
	if err != nil || !strings.HasPrefix(raw, "0.0357") {
		t.Errorf("stored coverage = %q (%v), want the exact 1/28", raw, err)
	}
}

// A single day computes to a sliver of its column, so a milestone gets a glyph
// instead — and the lane colour at full strength behind it, so it stays
// findable while scanning.
func TestMilestoneGetsADiamond(t *testing.T) {
	l := lane("Backend", "green")
	l.Milestones = []model.Milestone{milestone(1, "Launch", "2026-02-14")}
	f := render(t, model.RoadmapFull{Lanes: []model.LaneFull{l}}, testOptions)
	if got := cell(t, f, sheetRoadmap, "S2"); got != milestoneGlyph {
		t.Errorf("milestone cell = %q, want %q", got, milestoneGlyph)
	}
	st := style(t, f, sheetRoadmap, "S2")
	if len(st.Fill.Color) == 0 || !strings.EqualFold(strings.TrimPrefix(st.Fill.Color[0], "FF"), laneHex("green")) {
		t.Errorf("milestone fill = %v, want the lane colour %s", st.Fill.Color, laneHex("green"))
	}
}

// Fuller columns get more of the lane's colour; the steps are quantised so a
// reader compares levels rather than shades.
func TestTimelineFillBlendsTowardWhite(t *testing.T) {
	full := timelineFill("green", 1)
	if full != laneHex("green") {
		t.Errorf("full coverage = %s, want the lane colour %s", full, laneHex("green"))
	}
	if a, b := timelineFill("green", 0.1), timelineFill("green", 0.2); a != b {
		t.Errorf("0.1 and 0.2 land in different steps: %s vs %s", a, b)
	}
	if a, b := timelineFill("green", 0.2), timelineFill("green", 0.6); a == b {
		t.Errorf("0.2 and 0.6 share a step: %s", a)
	}
	// An unknown stored colour falls back the way the frontend's does.
	if timelineFill("chartreuse", 1) != laneHex("blue") {
		t.Errorf("unknown lane colour did not fall back to blue")
	}
}

// dependencyRoadmap wires three edges into one item, deliberately out of
// canonical order; the last of them is the one the calendar contradicts,
// because the gate is needed by work that ends before it.
func dependencyRoadmap() model.RoadmapFull {
	l := lane("Backend", "blue", items(
		item(1, "First", "2026-01-01", "2026-01-31"),
		item(2, "Second", "2026-02-01", "2026-02-28"),
		item(3, "Third", "2026-02-05", "2026-02-20"),
	))
	l.Milestones = []model.Milestone{milestone(9, "Gate", "2026-04-30")}
	return model.RoadmapFull{
		Lanes: []model.LaneFull{l},
		Dependencies: []model.Dependency{
			dep(1, model.DepItem, 3, model.DepItem, 2),
			dep(2, model.DepItem, 1, model.DepItem, 2),
			dep(3, model.DepMilestone, 9, model.DepItem, 2),
		},
	}
}

// Dependencies list WBS numbers in canonical order, in both directions, and a
// conflicting edge is red on both endpoints' rows.
func TestDependencyCells(t *testing.T) {
	f := render(t, dependencyRoadmap(), testOptions)
	// Rows: 2 = A.1 Gate, 3 = A.2 First, 4 = A.3 Second, 5 = A.4 Third.
	if got := cell(t, f, sheetRoadmap, "Q4"); got != "A.1, A.2, A.4" {
		t.Errorf("depends on = %q, want canonical order", got)
	}
	if got := cell(t, f, sheetRoadmap, "R3"); got != "A.3" {
		t.Errorf("needed by = %q", got)
	}
	if got := cell(t, f, sheetRoadmap, "R2"); got != "A.3" {
		t.Errorf("milestone needed by = %q", got)
	}

	red := func(ref string) []string {
		runs, err := f.GetCellRichText(sheetRoadmap, ref)
		if err != nil {
			t.Fatalf("rich text %s: %v", ref, err)
		}
		var marked []string
		for _, r := range runs {
			if r.Font != nil && strings.EqualFold(strings.TrimPrefix(r.Font.Color, "FF"), conflictColor) {
				marked = append(marked, r.Text)
			}
		}
		return marked
	}
	// Exactly the conflicting edge, on both of its endpoints.
	if got := red("Q4"); len(got) != 1 || got[0] != "A.1" {
		t.Errorf("red runs in Q4 = %v, want [A.1]", got)
	}
	if got := red("R2"); len(got) != 1 || got[0] != "A.3" {
		t.Errorf("red runs in R2 = %v, want [A.3]", got)
	}
	if got := red("R3"); len(got) != 0 {
		t.Errorf("red runs in R3 = %v, want none", got)
	}
}

// A hyperlink collapses a cell's line breaks in both Excel and LibreOffice, so
// a cell is a link or a list, never both.
func TestLinksCellHyperlink(t *testing.T) {
	f := render(t, fullRoadmap(), testOptions)
	// Two links in the description: plain text, and nothing to click.
	if ok, _, _ := f.GetCellHyperLink(sheetRoadmap, "O"+rowItem); ok {
		t.Error("a multi-link cell carries a hyperlink, which would eat its line breaks")
	}
	if st := style(t, f, sheetRoadmap, "O"+rowItem); st.Font.Underline != "" {
		t.Error("a multi-link cell is styled as a link it cannot be")
	}

	// One link: the cell is that link.
	rm := fullRoadmap()
	rm.Lanes[0].Items[0].Description = "spec at [the design](https://x.test/design)"
	f = render(t, rm, testOptions)
	ok, target, err := f.GetCellHyperLink(sheetRoadmap, "O"+rowItem)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || target != "https://x.test/design" {
		t.Errorf("hyperlink = %v %q, want the only link", ok, target)
	}
	if got := cell(t, f, sheetRoadmap, "O"+rowItem); got != "the design" {
		t.Errorf("link cell = %q, want the label", got)
	}
	if ok, _, _ := f.GetCellHyperLink(sheetRoadmap, "O"+rowMilestone); ok {
		t.Error("a description with no links still produced a hyperlink")
	}
}

// The description is written exactly as it was authored — blank lines and all.
// The cell wraps, which is what makes a break render at all.
func TestDescriptionIsVerbatim(t *testing.T) {
	const written = "Describe it\n\n\nhttps://x.test/a\nhttps://x.test/b"
	rm := fullRoadmap()
	rm.Lanes[0].Items[0].Description = written
	f := render(t, rm, testOptions)
	if got := cell(t, f, sheetRoadmap, "P"+rowItem); got != written {
		t.Errorf("description = %q, want it unchanged: %q", got, written)
	}
	if st := style(t, f, sheetRoadmap, "P"+rowItem); st.Alignment == nil || !st.Alignment.WrapText {
		t.Errorf("description alignment = %+v, want wrapping", st.Alignment)
	}
}

// A row is as tall as its text's own lines, up to the cap. Beyond it the text
// stays in the cell and only the view of it stops.
func TestRowHeightFollowsTheTextUpToTheCap(t *testing.T) {
	row, err := strconv.Atoi(rowItem)
	if err != nil {
		t.Fatal(err)
	}
	heightFor := func(t *testing.T, description string) float64 {
		t.Helper()
		rm := fullRoadmap()
		rm.Lanes[0].Items[0].Description = description
		f := render(t, rm, testOptions)
		if got := cell(t, f, sheetRoadmap, "P"+rowItem); got != description {
			t.Errorf("the row lost text; the cap is a height, not a truncation")
		}
		h, err := f.GetRowHeight(sheetRoadmap, row)
		if err != nil {
			t.Fatal(err)
		}
		return h
	}
	for _, tc := range []struct {
		name        string
		description string
		want        float64
	}{
		{"one line", "Just the one.", lineHeight},
		{"two lines", "First.\nSecond.", 2 * lineHeight},
		{"three lines", "First.\nSecond.\nThird.", 3 * lineHeight},
		{"past the cap", "a\nb\nc\nd\ne\nf", maxRowLines * lineHeight},
		// A single line has one line however long it is: what the column's
		// width does to it is not what the row is sized to.
		{"one very long line", strings.Repeat("long ", 200), lineHeight},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := heightFor(t, tc.description); got != tc.want {
				t.Errorf("row height = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestLineCount(t *testing.T) {
	for _, tc := range []struct {
		text string
		want int
	}{
		{"", 1},
		{"short", 1},
		{strings.Repeat("x", 500), 1},
		{"one\ntwo\nthree", 3},
		{"trailing\n", 2},
	} {
		if got := lineCount(tc.text); got != tc.want {
			t.Errorf("lineCount(%q) = %d, want %d", tc.text, got, tc.want)
		}
	}
}

func TestInfoSheet(t *testing.T) {
	f := render(t, fullRoadmap(), testOptions)
	want := map[string]string{
		"A1": "Roadmap", "B1": "Platform 2026",
		"A2": "Roadmap ID", "B2": "42",
		"A3": "Roadmap UID", "B3": "rm-uid-42",
		"A4": "Exported (UTC)", "B4": "2026-03-14 15:09:26",
		"A5": "Contexts", "B5": "1",
		"A6": "Items", "B6": "2",
		"A7": "Milestones", "B7": "1",
		"A8": "Dependencies", "B8": "0",
		"A9": "Timeline unit", "B9": string(unitPeriods),
	}
	for ref, w := range want {
		if got := cell(t, f, sheetInfo, ref); got != w {
			t.Errorf("Info!%s = %q, want %q", ref, got, w)
		}
	}
	// The timeline only names the periods the work reaches, so the full
	// schedule — PI 2 included, which no work overlaps — is stated here.
	cols, _ := timelineColumns(fullRoadmap())
	for _, c := range cols {
		if c.label == "PI 2" {
			t.Fatal("PI 2 reached the timeline; the fixture no longer tests an unreached period")
		}
	}
	if got := cell(t, f, sheetInfo, "A14"); got != "PI 2" {
		t.Errorf("Info!A14 = %q, want the unreached period PI 2", got)
	}
	if got := cell(t, f, sheetInfo, "B14"); got != "2026-03-01" {
		t.Errorf("Info!B14 = %q", got)
	}
	props, err := f.GetDocProps()
	if err != nil {
		t.Fatal(err)
	}
	if props.Title != "Platform 2026" || props.Creator != "Roadie" ||
		props.Created != testOptions.ExportedAt.Format(time.RFC3339) {
		t.Errorf("doc props = %+v", props)
	}
}

func TestLayout(t *testing.T) {
	f := render(t, fullRoadmap(), testOptions)
	if got := cell(t, f, sheetRoadmap, "A1"); got != "WBS" {
		t.Errorf("row 1 is not the header: A1 = %q", got)
	}
	// The column style is applied before any cell is written; applied after, it
	// would have flattened the header and every cell below it.
	if st := style(t, f, sheetRoadmap, "A1"); st.Font == nil || !st.Font.Bold {
		t.Errorf("the header lost its own style: %+v", st.Font)
	}
	if st := style(t, f, sheetRoadmap, "E"+rowItem); st.CustomNumFmt == nil {
		t.Errorf("a date cell lost its own style: %+v", st)
	}
	// Cells with no style of their own follow the column, so a row that grew
	// for a multi-line cell does not leave them at its foot.
	id, err := f.GetColStyle(sheetRoadmap, "B")
	if err != nil {
		t.Fatal(err)
	}
	col, err := f.GetStyle(id)
	if err != nil {
		t.Fatal(err)
	}
	if col.Alignment == nil || col.Alignment.Vertical != "top" {
		t.Errorf("column style alignment = %+v, want top", col.Alignment)
	}
	if list := f.GetSheetList(); len(list) != 2 || list[0] != sheetRoadmap || list[1] != sheetInfo {
		t.Errorf("sheets = %v", list)
	}
	if f.GetActiveSheetIndex() != 0 {
		t.Errorf("active sheet = %d, want the roadmap", f.GetActiveSheetIndex())
	}
	// Nothing is pinned: the first columns are too wide to give up a third of
	// the window to.
	panes, err := f.GetPanes(sheetRoadmap)
	if err != nil {
		t.Fatal(err)
	}
	if panes.Freeze {
		t.Errorf("panes = %+v, want no frozen pane", panes)
	}
	for _, col := range []string{"N", "O", "P"} {
		level, err := f.GetColOutlineLevel(sheetRoadmap, col)
		if err != nil || level != 1 {
			t.Errorf("outline level of %s = %d (%v), want 1", col, level, err)
		}
	}
	if level, _ := f.GetColOutlineLevel(sheetRoadmap, "Q"); level != 0 {
		t.Errorf("Q is inside the collapsible group")
	}
}

// The filter range is what a sort through its dropdowns reorders, so it has to
// reach the last timeline column: anything short of that sorts the table and
// leaves the bars where they were.
func TestAutoFilterCoversTheTimeline(t *testing.T) {
	rm := fullRoadmap()
	cols, _ := timelineColumns(rm)
	if len(cols) == 0 {
		t.Fatal("the fixture has no timeline to cover")
	}
	last := columnName(colTimeline + len(cols) - 1)
	want := fmt.Sprintf(`<autoFilter ref="$A$1:$%s$%d"`, last, 1+len(buildRows(rm)))
	xml := part(t, renderBytes(t, rm, testOptions), "xl/worksheets/sheet1.xml")
	if !strings.Contains(xml, want) {
		i := strings.Index(xml, "<autoFilter ")
		t.Errorf("autofilter = %q, want %s", xml[i:i+min(len(xml)-i, 60)], want)
	}
}

// Every font in the workbook names bodyFont. A style that leaves the name unset
// falls back to the reader's theme font, which is Calibri in Excel and
// something else everywhere Calibri is not installed.
func TestEveryFontIsNamed(t *testing.T) {
	f := render(t, fullRoadmap(), testOptions)
	if got, err := f.GetDefaultFont(); err != nil || got != bodyFont {
		t.Errorf("default font = %q (%v), want %q", got, err, bodyFont)
	}
	// One cell per style that sets a font of its own.
	for _, ref := range []string{"A1", "C" + rowChild, "E" + rowItem, "O" + rowItem, "S" + rowItem} {
		st := style(t, f, sheetRoadmap, ref)
		if st.Font == nil || st.Font.Family != bodyFont {
			t.Errorf("%s font = %+v, want %q", ref, st.Font, bodyFont)
		}
	}
	runs, err := render(t, dependencyRoadmap(), testOptions).GetCellRichText(sheetRoadmap, "Q4")
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) == 0 {
		t.Fatal("no rich text to check")
	}
	for i, r := range runs {
		if r.Font == nil || r.Font.Family != bodyFont {
			t.Errorf("dependency run %d font = %+v, want %q", i, r.Font, bodyFont)
		}
	}
}

// The column constants are written out by hand; this is what keeps them lined
// up with the headers they name.
func TestColumnConstantsMatchHeaders(t *testing.T) {
	if colTimeline != len(columns)+1 {
		t.Fatalf("colTimeline = %d, want %d (one past %d fixed columns)",
			colTimeline, len(columns)+1, len(columns))
	}
	for i, want := range map[int]string{
		colWBS: "WBS", colType: "Type", colLabels: "Labels",
		colLinks: "Links", colDescription: "Description", colNeededBy: "Needed by",
	} {
		if got := columns[i-1].header; got != want {
			t.Errorf("column %d is %q, want %q", i, got, want)
		}
	}
}

func TestDegenerateRoadmaps(t *testing.T) {
	for _, tc := range []struct {
		name string
		rm   model.RoadmapFull
	}{
		{"no contexts", model.RoadmapFull{Roadmap: model.Roadmap{Name: "Empty"}}},
		{"contexts but no entities", model.RoadmapFull{
			Roadmap: model.Roadmap{Name: "Empty"},
			Lanes:   []model.LaneFull{lane("Backend", "blue"), lane("Frontend", "red")},
		}},
		{"no schedule", model.RoadmapFull{
			Roadmap: model.Roadmap{Name: "Plain"},
			Lanes:   []model.LaneFull{lane("Backend", "blue", items(item(1, "Work", "2026-01-01", "2026-01-31")))},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := render(t, tc.rm, testOptions)
			if got := cell(t, f, sheetRoadmap, "A1"); got != "WBS" {
				t.Errorf("header missing: A1 = %q", got)
			}
			if got := cell(t, f, sheetInfo, "B1"); got != tc.rm.Name {
				t.Errorf("Info name = %q", got)
			}
		})
	}

	// Without dated content there is no timeline at all, and the Info sheet
	// says so rather than leaving the reader guessing.
	f := render(t, model.RoadmapFull{Lanes: []model.LaneFull{lane("Backend", "blue")}}, testOptions)
	if got := cell(t, f, sheetRoadmap, "S1"); got != "" {
		t.Errorf("S1 = %q, want no timeline", got)
	}
	if got := cell(t, f, sheetInfo, "B9"); got != string(unitNone) {
		t.Errorf("timeline unit = %q, want %q", got, unitNone)
	}
	if got := cell(t, f, sheetInfo, "A11"); got != "Schedule" {
		t.Errorf("Info!A11 = %q", got)
	}
	if got := cell(t, f, sheetInfo, "A12"); got != "No schedule defined" {
		t.Errorf("Info!A12 = %q", got)
	}
}
