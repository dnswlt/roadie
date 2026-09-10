package sheet

import (
	"encoding/json"

	"github.com/xuri/excelize/v2"
)

// bodyFont is set both as the workbook default and on every style below.
// Excel's own default, Calibri, ships with Office and nothing else, so a reader
// without it substitutes on its own and the column widths stop meaning
// anything. Arial is present on Windows and macOS, and Linux readers substitute
// the metric-compatible Liberation Sans for it.
//
// A style whose Font leaves Family empty writes no font name at all and falls
// back to the theme's — which is why every one of them names it.
const bodyFont = "Arial"

// Number formats are custom: the built-in date format is locale-dependent, and
// a percentage of a period has no built-in at all.
const (
	fmtDate     = "yyyy-mm-dd"
	fmtDateTime = "yyyy-mm-dd hh:mm:ss"
	fmtPercent  = "0%"
)

const (
	// A conflicting dependency renders red rather than the app's amber:
	// --danger is chrome-only on the *timeline*, and a sheet is not the
	// timeline.
	conflictColor = "C92C2C"
	headerFill    = "EFEFEF"
	borderColor   = "BFBFBF"
	linkColor     = "0563C1"
)

// styles is the workbook's style registry. excelize hands out an integer per
// distinct format; cells here ask by shape, so a combination is registered once
// however many cells want it. The error is sticky — a style that could not be
// created would otherwise have to be checked at every call site.
type styles struct {
	f     *excelize.File
	cache map[string]int
	err   error
}

func newStyles(f *excelize.File) *styles {
	return &styles{f: f, cache: map[string]int{}}
}

func (s *styles) id(st excelize.Style) int {
	if s.err != nil {
		return 0
	}
	key, err := json.Marshal(st)
	if err != nil {
		s.err = err
		return 0
	}
	if id, ok := s.cache[string(key)]; ok {
		return id
	}
	id, err := s.f.NewStyle(&st)
	if err != nil {
		s.err = err
		return 0
	}
	s.cache[string(key)] = id
	return id
}

// font names bodyFont on a font the caller describes by everything else.
func font(f excelize.Font) *excelize.Font {
	f.Family = bodyFont
	return &f
}

func (s *styles) header() int {
	return s.id(excelize.Style{
		Font:      font(excelize.Font{Bold: true}),
		Fill:      excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{headerFill}},
		Alignment: &excelize.Alignment{Vertical: "bottom", Horizontal: "left"},
		Border:    []excelize.Border{{Type: "bottom", Style: 1, Color: borderColor}},
	})
}

// body is the sheet's baseline, applied to the columns so that cells with no
// style of their own follow it. Top alignment because a row grows when its
// Links cell holds several lines, and bottom-aligned neighbours then hang at
// the foot of the taller row.
func (s *styles) body() int {
	return s.id(excelize.Style{
		Font:      font(excelize.Font{}),
		Alignment: &excelize.Alignment{Vertical: "top"},
	})
}

func (s *styles) bold() int {
	return s.id(excelize.Style{Font: font(excelize.Font{Bold: true})})
}

func (s *styles) date() int {
	return s.id(excelize.Style{
		Font:         font(excelize.Font{}),
		CustomNumFmt: ptr(fmtDate),
		Alignment:    &excelize.Alignment{Vertical: "top"},
	})
}

func (s *styles) dateTime() int {
	return s.id(excelize.Style{Font: font(excelize.Font{}), CustomNumFmt: ptr(fmtDateTime)})
}

// indented is the name cell of a child. Excel's alignment indent rather than a
// "- " prefix, which would end up inside a pivot label or a filter value.
func (s *styles) indented() int {
	return s.id(excelize.Style{
		Font:      font(excelize.Font{}),
		Alignment: &excelize.Alignment{Horizontal: "left", Vertical: "top", Indent: 1},
	})
}

// link is a cell that is one hyperlink. No wrap: the cell holds a single line,
// and a long URL is better clipped by its neighbour than made to grow the row.
func (s *styles) link() int {
	return s.id(excelize.Style{
		Font:      font(excelize.Font{Color: linkColor, Underline: "single"}),
		Alignment: &excelize.Alignment{Vertical: "top"},
	})
}

// wrapped is free text that keeps its own line breaks. WrapText is what makes
// a break render at all: without it the two lines are drawn as one, with the
// words either side of the break run together.
func (s *styles) wrapped() int {
	return s.id(excelize.Style{
		Font:      font(excelize.Font{}),
		Alignment: &excelize.Alignment{Vertical: "top", WrapText: true},
	})
}

// coverage is a timeline cell carrying a fraction of a column.
func (s *styles) coverage(fill string) int {
	return s.id(excelize.Style{
		Font:         font(excelize.Font{}),
		CustomNumFmt: ptr(fmtPercent),
		Fill:         excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{fill}},
		Alignment:    &excelize.Alignment{Horizontal: "center", Vertical: "top"},
	})
}

// milestoneMark is the diamond's cell: the lane colour at full strength, so a
// landmark stays findable rather than fading to the ~1% a single day covers.
func (s *styles) milestoneMark(fill string) int {
	return s.id(excelize.Style{
		Font:      font(excelize.Font{}),
		Fill:      excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{fill}},
		Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "top"},
	})
}

func ptr[T any](v T) *T { return &v }
