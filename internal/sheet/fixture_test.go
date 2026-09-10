package sheet

import (
	"archive/zip"
	"bytes"
	"io"
	"testing"
	"time"

	"github.com/dnswlt/roadie/internal/model"
	"github.com/xuri/excelize/v2"
)

// The tests build model values directly and read the produced workbook back
// with excelize: no database, and no assertions about bytes nobody can read.

func date(s string) model.Date {
	d, err := model.ParseDate(s)
	if err != nil {
		panic(err)
	}
	return d
}

func mustItem(id int64, title, start, end string) model.Item {
	return model.Item{ID: id, Title: title, StartDate: date(start), EndDate: date(end)}
}

func item(id int64, title, start, end string) model.ItemFull {
	return model.ItemFull{Item: mustItem(id, title, start, end)}
}

func items(is ...model.ItemFull) []model.ItemFull { return is }

func milestone(id int64, title, on string) model.Milestone {
	return model.Milestone{ID: id, UID: "uid-" + title, Title: title, Date: date(on)}
}

func lane(name, color string, its ...[]model.ItemFull) model.LaneFull {
	l := model.LaneFull{Lane: model.Lane{Name: name, Color: color}}
	for _, group := range its {
		l.Items = append(l.Items, group...)
	}
	return l
}

func period(label, start, end string) model.SchedulePeriod {
	return model.SchedulePeriod{Label: label, StartDate: date(start), EndDate: date(end)}
}

func dep(id int64, fromKind string, fromID int64, toKind string, toID int64) model.Dependency {
	return model.Dependency{
		ID:   id,
		From: model.DependencyRef{Kind: fromKind, ID: fromID},
		To:   model.DependencyRef{Kind: toKind, ID: toID},
	}
}

var testOptions = Options{ExportedAt: time.Date(2026, 3, 14, 15, 9, 26, 0, time.UTC)}

// render writes the roadmap and reopens it, which is the only way to assert on
// what a reader will actually see.
func render(t *testing.T, rm model.RoadmapFull, opts Options) *excelize.File {
	t.Helper()
	f, err := excelize.OpenReader(bytes.NewReader(renderBytes(t, rm, opts)))
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func renderBytes(t *testing.T, rm model.RoadmapFull, opts Options) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := Write(&buf, rm, opts); err != nil {
		t.Fatalf("Write: %v", err)
	}
	return buf.Bytes()
}

// part returns one file from inside the workbook, for the few settings excelize
// writes but offers no way to read back.
func part(t *testing.T, data []byte, name string) string {
	t.Helper()
	r, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	f, err := r.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	body, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func cell(t *testing.T, f *excelize.File, sheet, ref string) string {
	t.Helper()
	v, err := f.GetCellValue(sheet, ref)
	if err != nil {
		t.Fatalf("read %s!%s: %v", sheet, ref, err)
	}
	return v
}

func style(t *testing.T, f *excelize.File, sheet, ref string) *excelize.Style {
	t.Helper()
	id, err := f.GetCellStyle(sheet, ref)
	if err != nil {
		t.Fatalf("style of %s!%s: %v", sheet, ref, err)
	}
	st, err := f.GetStyle(id)
	if err != nil {
		t.Fatalf("style %d: %v", id, err)
	}
	return st
}
