// Package sheet renders a roadmap as an .xlsx workbook: one row per entity,
// the work breakdown on the left and a coloured period/month grid on the right.
// Export only — nothing here reads a workbook back.
//
// Pure by design: no database, no HTTP, no globals. The one thing that would
// otherwise be ambient — the export timestamp — arrives in Options, which is
// what lets a test pin the output.
package sheet

import (
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/dnswlt/roadie/internal/model"
	"github.com/xuri/excelize/v2"
)

// Both tab names are fixed: Excel caps a tab at 31 characters and rejects
// : \ / ? * [ ], so a roadmap name cannot be one.
const (
	sheetRoadmap = "Roadmap"
	sheetInfo    = "Info"
)

// headerRow is row 1 — there is no title block above it, so every reader that
// assumes row 1 is the header keeps working.
const headerRow = 1

// The fixed columns, in order; the timeline follows the last of them.
var columns = []struct {
	header string
	width  float64
}{
	{"WBS", 9},
	{"Context", 18},
	{"Name", 42},
	{"Type", 12},
	{"Start", 12},
	{"End", 12},
	{"Days", 7},
	{"Start period", 14},
	{"End period", 14},
	{"Priority", 9},
	{"Tentative", 10},
	{"At risk", 9},
	{"Flagged", 9},
	{"Labels", 24},
	{"Links", 42},
	{"Description", 60},
	{"Depends on", 16},
	{"Needed by", 16},
}

// Column numbers, in the order above. colTimeline is one past the last fixed
// column, which TestColumnConstantsMatchHeaders pins against len(columns).
const (
	colWBS = iota + 1
	colContext
	colName
	colType
	colStart
	colEnd
	colDays
	colStartPeriod
	colEndPeriod
	colPriority
	colTentative
	colAtRisk
	colFlagged
	colLabels
	colLinks
	colDescription
	colDependsOn
	colNeededBy
	colTimeline
)

// The free text collapses as one group, so the timeline can be pulled up
// against the dates.
const (
	colGroupFirst = colLabels
	colGroupLast  = colDescription
)

const (
	timelineWidth  = 9
	milestoneGlyph = "◆"
)

// maxRowLines caps how tall one entity's row may grow. A description is free
// text and can run to a page of it; three lines shows the start of one without
// turning a table into a document.
//
// A row is sized to the lines its text actually holds, capped — never to what
// the column's width does to a long line. The cap is a stated row height, which
// is also what stops the growth: Excel and LibreOffice fit a row to its
// contents only while its height is unset. Nothing is truncated; the whole
// description is in the cell, one drag of the row border away.
const (
	maxRowLines = 3
	lineHeight  = 15 // points, and the workbook's default row height
)

// Options carries what the renderer must not invent for itself.
type Options struct {
	// ExportedAt stamps the Info sheet and the document properties.
	ExportedAt time.Time
}

// Write renders the roadmap as an .xlsx workbook.
func Write(w io.Writer, rm model.RoadmapFull, opts Options) error {
	f := excelize.NewFile()
	defer f.Close()

	x := &writer{f: f, st: newStyles(f), rm: rm, opts: opts}
	x.call(f.SetDefaultFont(bodyFont))
	x.rows = buildRows(rm)
	x.cols, x.unit = timelineColumns(rm)
	x.indexDeps()

	x.call(f.SetSheetName("Sheet1", sheetRoadmap))
	if _, err := f.NewSheet(sheetInfo); err != nil {
		x.call(err)
	}
	x.writeRoadmap()
	x.writeInfo()
	x.writeProps()
	f.SetActiveSheet(0)

	if x.err != nil {
		return x.err
	}
	if x.st.err != nil {
		return x.st.err
	}
	return f.Write(w)
}

// writer holds the workbook under construction and the first error to happen
// to it. Every helper below is a no-op once that error is set, so the layout
// code reads as layout rather than as error handling.
type writer struct {
	f    *excelize.File
	st   *styles
	rm   model.RoadmapFull
	opts Options
	err  error

	rows []row
	cols []column
	unit timelineUnit
	// Both directions of every edge, keyed by the row it renders on.
	dependsOn, neededBy map[string][]depRef
}

func (x *writer) call(err error) {
	if x.err == nil {
		x.err = err
	}
}

func (x *writer) set(sheet string, col, row int, v any) {
	x.call(x.f.SetCellValue(sheet, cellName(col, row), v))
}

func (x *writer) styled(sheet string, col, row, style int, v any) {
	x.set(sheet, col, row, v)
	x.call(x.f.SetCellStyle(sheet, cellName(col, row), cellName(col, row), style))
}

func (x *writer) style(sheet string, col, row, style int) {
	x.call(x.f.SetCellStyle(sheet, cellName(col, row), cellName(col, row), style))
}

// cellName is total for every coordinate generated here: rows and columns are
// counted from 1.
func cellName(col, row int) string {
	name, _ := excelize.CoordinatesToCellName(col, row)
	return name
}

func columnName(col int) string {
	name, _ := excelize.ColumnNumberToName(col)
	return name
}

// ---------------------------------------------------------------- Roadmap ---

func (x *writer) writeRoadmap() {
	lastCol := colTimeline + len(x.cols) - 1

	// Before any cell is written: SetColStyle also stamps the rows that already
	// exist, so applied later it would flatten every style below.
	x.call(x.f.SetColStyle(sheetRoadmap,
		columnName(1)+":"+columnName(lastCol), x.st.body()))

	for i, c := range columns {
		col := i + 1
		x.styled(sheetRoadmap, col, headerRow, x.st.header(), c.header)
		x.call(x.f.SetColWidth(sheetRoadmap, columnName(col), columnName(col), c.width))
	}
	for i, c := range x.cols {
		x.styled(sheetRoadmap, colTimeline+i, headerRow, x.st.header(), c.label)
	}
	if len(x.cols) > 0 {
		x.call(x.f.SetColWidth(sheetRoadmap, columnName(colTimeline), columnName(lastCol), timelineWidth))
	}

	for i, r := range x.rows {
		x.writeRow(i+headerRow+1, r)
	}

	for col := colGroupFirst; col <= colGroupLast; col++ {
		x.call(x.f.SetColOutlineLevel(sheetRoadmap, columnName(col), 1))
	}
	// The whole used range, timeline included. The range is not just what the
	// dropdowns filter, it is what a sort through them reorders: a range that
	// stopped at the fixed columns would sort those and leave every row's bars
	// behind, silently pairing each entity with somebody else's dates. A
	// dropdown per timeline column is the cost of that not being possible.
	x.call(x.f.AutoFilter(sheetRoadmap,
		fmt.Sprintf("%s:%s", cellName(1, headerRow), cellName(lastCol, headerRow+len(x.rows))), nil))
}

func (x *writer) writeRow(n int, r row) {
	x.set(sheetRoadmap, colWBS, n, r.wbs)
	x.set(sheetRoadmap, colContext, n, r.context)
	x.set(sheetRoadmap, colName, n, r.title)
	if r.kind == kindChild {
		x.style(sheetRoadmap, colName, n, x.st.indented())
	}
	x.set(sheetRoadmap, colType, n, r.typeText())
	x.styled(sheetRoadmap, colStart, n, x.st.date(), dateSerial(r.start))
	x.styled(sheetRoadmap, colEnd, n, x.st.date(), dateSerial(r.end))
	if d := r.duration(); d > 0 {
		x.set(sheetRoadmap, colDays, n, d)
	}
	x.set(sheetRoadmap, colStartPeriod, n, periodContaining(x.rm.Periods, r.start))
	x.set(sheetRoadmap, colEndPeriod, n, periodContaining(x.rm.Periods, r.end))
	if r.priority != nil {
		x.set(sheetRoadmap, colPriority, n, "P"+strconv.Itoa(*r.priority))
	}
	x.set(sheetRoadmap, colTentative, n, yesOrBlank(r.tentative))
	x.set(sheetRoadmap, colAtRisk, n, yesOrBlank(r.atRisk))
	x.set(sheetRoadmap, colFlagged, n, yesOrBlank(r.flagged))
	x.set(sheetRoadmap, colLabels, n, strings.Join(r.labels, ", "))
	if r.description != "" {
		x.styled(sheetRoadmap, colDescription, n, x.st.wrapped(), r.description)
	}
	lines := max(x.writeLinks(n, r.description), lineCount(r.description))
	x.call(x.f.SetRowHeight(sheetRoadmap, n, float64(min(lines, maxRowLines)*lineHeight)))
	x.writeDeps(colDependsOn, n, x.dependsOn[refKey(r.ref)])
	x.writeDeps(colNeededBy, n, x.neededBy[refKey(r.ref)])
	x.writeTimeline(n, r)
}

// writeLinks fills the Links cell with the HTTP(S) links in the description,
// and reports how many lines it needs.
//
// A cell holds at most one hyperlink, and attaching one makes both Excel and
// LibreOffice render the cell as a single run — the line breaks inside it
// disappear. So the two cases are drawn differently rather than fudged into
// one: a lone link *is* the cell, clickable and styled as a link, with its URL
// in the tooltip; several are plain text, one per line. Styling those as links
// would promise a click target the format cannot give. Either way the cell
// names the links; the URLs behind them are in the description beside it.
func (x *writer) writeLinks(n int, description string) int {
	links := extractLinks(description)
	if len(links) == 0 {
		return 1
	}
	if len(links) == 1 {
		x.styled(sheetRoadmap, colLinks, n, x.st.link(), links[0].label)
		tooltip := links[0].url
		x.call(x.f.SetCellHyperLink(sheetRoadmap, cellName(colLinks, n), links[0].url, "External",
			excelize.HyperlinkOpts{Tooltip: &tooltip}))
		return 1
	}
	labels := make([]string, len(links))
	for i, l := range links {
		labels[i] = l.label
	}
	x.styled(sheetRoadmap, colLinks, n, x.st.wrapped(), strings.Join(labels, "\n"))
	return len(labels)
}

// writeDeps renders one dependency cell. A number whose edge the calendar
// contradicts is its own red run, on both endpoints' rows.
func (x *writer) writeDeps(col, n int, refs []depRef) {
	if len(refs) == 0 {
		return
	}
	runs := make([]excelize.RichTextRun, 0, 2*len(refs))
	for i, d := range refs {
		if i > 0 {
			runs = append(runs, excelize.RichTextRun{Text: ", ", Font: font(excelize.Font{})})
		}
		run := excelize.RichTextRun{Text: d.wbs, Font: font(excelize.Font{})}
		if d.conflict {
			run.Font = font(excelize.Font{Color: conflictColor})
		}
		runs = append(runs, run)
	}
	x.call(x.f.SetCellRichText(sheetRoadmap, cellName(col, n), runs))
}

// writeTimeline fills the grid: how much of each column the entity occupies,
// stored exact and displayed as a whole percentage, blank at zero. A milestone
// gets a diamond in its column instead of the sliver a single day computes to.
//
// A column that absorbed a schedule gap is longer than its period, so an item
// filling that period reads below 100% — the coverage is of the column.
func (x *writer) writeTimeline(n int, r row) {
	from, to := dayOf(r.start), dayOf(r.end)
	for i, c := range x.cols {
		col := colTimeline + i
		overlap := c.overlap(from, to)
		switch {
		case overlap == 0:
		case r.kind == kindMilestone:
			x.styled(sheetRoadmap, col, n, x.st.milestoneMark(laneHex(r.color)), milestoneGlyph)
		default:
			coverage := float64(overlap) / float64(c.days())
			x.styled(sheetRoadmap, col, n, x.st.coverage(timelineFill(r.color, coverage)), coverage)
		}
	}
}

// ------------------------------------------------------------------- Info ---

func (x *writer) writeInfo() {
	n := 1
	pair := func(key string, value any) {
		x.styled(sheetInfo, 1, n, x.st.bold(), key)
		x.set(sheetInfo, 2, n, value)
		n++
	}
	x.call(x.f.SetColWidth(sheetInfo, "A", "A", 22))
	x.call(x.f.SetColWidth(sheetInfo, "B", "C", 28))

	pair("Roadmap", x.rm.Name)
	pair("Roadmap ID", x.rm.ID)
	pair("Roadmap UID", x.rm.UID)
	x.styled(sheetInfo, 1, n, x.st.bold(), "Exported (UTC)")
	x.styled(sheetInfo, 2, n, x.st.dateTime(), timeSerial(x.opts.ExportedAt))
	n++

	items, milestones := 0, 0
	for _, r := range x.rows {
		if r.kind == kindMilestone {
			milestones++
		} else {
			items++
		}
	}
	pair("Contexts", len(x.rm.Lanes))
	pair("Items", items)
	pair("Milestones", milestones)
	pair("Dependencies", len(x.rm.Dependencies))
	pair("Timeline unit", string(x.unit))
	n++

	// The timeline names periods by label and covers only the ones the work
	// reaches, so this is the only place the schedule is stated in full.
	x.styled(sheetInfo, 1, n, x.st.bold(), "Schedule")
	n++
	if len(x.rm.Periods) == 0 {
		x.set(sheetInfo, 1, n, "No schedule defined")
		return
	}
	for i, header := range []string{"Period", "Start", "End"} {
		x.styled(sheetInfo, i+1, n, x.st.header(), header)
	}
	n++
	for _, p := range x.rm.Periods {
		x.set(sheetInfo, 1, n, p.Label)
		x.styled(sheetInfo, 2, n, x.st.date(), dateSerial(p.StartDate))
		x.styled(sheetInfo, 3, n, x.st.date(), dateSerial(p.EndDate))
		n++
	}
}

func (x *writer) writeProps() {
	stamp := x.opts.ExportedAt.UTC().Format(time.RFC3339)
	x.call(x.f.SetDocProps(&excelize.DocProperties{
		Title:    x.rm.Name,
		Creator:  "Roadie",
		Created:  stamp,
		Modified: stamp,
	}))
}

// ----------------------------------------------------------- Dependencies ---

// depRef is one end of an edge as it renders in a dependency cell.
type depRef struct {
	wbs      string
	order    int
	conflict bool
}

func refKey(r model.DependencyRef) string {
	return fmt.Sprintf("%s:%d", r.Kind, r.ID)
}

// indexDeps resolves every edge to the two cells it renders in. Endpoints are
// named by WBS number and listed in canonical order, matching the panel's
// splitDeps rather than the order the edges happened to be created in.
//
// A conflicting edge — the prerequisite ending after the dependent, the
// finish-to-finish check deps-graph.ts calls dateConflict — is marked on both
// rows: the contradiction belongs to the pair, not to one end of it.
func (x *writer) indexDeps() {
	x.dependsOn = map[string][]depRef{}
	x.neededBy = map[string][]depRef{}
	type entity struct {
		wbs   string
		order int
		end   int
	}
	index := make(map[string]entity, len(x.rows))
	for i, r := range x.rows {
		index[refKey(r.ref)] = entity{wbs: r.wbs, order: i, end: dayOf(r.end)}
	}
	for _, d := range x.rm.Dependencies {
		from, okFrom := index[refKey(d.From)]
		to, okTo := index[refKey(d.To)]
		if !okFrom || !okTo {
			continue
		}
		conflict := from.end > to.end
		x.dependsOn[refKey(d.To)] = append(x.dependsOn[refKey(d.To)],
			depRef{wbs: from.wbs, order: from.order, conflict: conflict})
		x.neededBy[refKey(d.From)] = append(x.neededBy[refKey(d.From)],
			depRef{wbs: to.wbs, order: to.order, conflict: conflict})
	}
	for _, m := range []map[string][]depRef{x.dependsOn, x.neededBy} {
		for _, refs := range m {
			sort.Slice(refs, func(i, j int) bool { return refs[i].order < refs[j].order })
		}
	}
}

// ---------------------------------------------------------------- Helpers ---

// periodContaining names the period a date falls *inside*, which is what makes
// the column worth filtering on; a date in a gap or outside the schedule names
// none. Deliberately unmarked when the date is not flush with the period's
// edge: a "~" prefix would split `PI 3` and `~PI 3` under that filter.
func periodContaining(periods []model.SchedulePeriod, d model.Date) string {
	day := dayOf(d)
	for _, p := range periods {
		if dayOf(p.StartDate) <= day && day <= dayOf(p.EndDate) {
			return p.Label
		}
	}
	return ""
}

// lineCount is how many lines a cell's text holds, which is how tall its row is
// asked to be. Only the breaks in the text count — a line too long for its
// column is left to wrap into the space the cap allows and no further.
func lineCount(text string) int {
	if text == "" {
		return 1
	}
	return strings.Count(text, "\n") + 1
}

func yesOrBlank(b bool) string {
	if b {
		return "Yes"
	}
	return ""
}
