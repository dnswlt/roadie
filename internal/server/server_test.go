package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/dnswlt/roadie/internal/model"
	"github.com/dnswlt/roadie/internal/store"
)

var testSrv *Server
var testStore *store.Store

func TestMain(m *testing.M) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		// No database available (e.g. CI without services); skip all tests.
		os.Exit(0)
	}
	ctx := context.Background()
	st, err := store.Connect(ctx, url)
	if err != nil {
		panic(err)
	}
	if err := st.Migrate(ctx); err != nil {
		panic(err)
	}
	testStore = st
	testSrv = New(st, fstest.MapFS{})
	code := m.Run()
	st.Close()
	os.Exit(code)
}

// do runs a request through the server and returns the recorder.
func do(t *testing.T, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r = httptest.NewRequest(method, path, bytes.NewReader(buf))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	w := httptest.NewRecorder()
	testSrv.ServeHTTP(w, r)
	return w
}

// doRaw posts a raw (possibly malformed) body, bypassing JSON marshalling.
func doRaw(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	testSrv.ServeHTTP(w, r)
	return w
}

// seedRoadmap builds a small roadmap (one lane, a parent+child item and a
// milestone) directly via the store and returns its id. It is removed when the
// test finishes.
func seedRoadmap(t *testing.T, name string) int64 {
	t.Helper()
	ctx := context.Background()
	rm, err := testStore.CreateRoadmap(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })
	lane, err := testStore.CreateLane(ctx, rm.ID, "Backend")
	if err != nil {
		t.Fatal(err)
	}
	start, _ := model.ParseDate("2026-01-01")
	end, _ := model.ParseDate("2026-02-01")
	parent, err := testStore.CreateItem(ctx, lane.ID, store.NewItem{
		Title: "Parent", StartDate: start, EndDate: end})
	if err != nil {
		t.Fatal(err)
	}
	cstart, _ := model.ParseDate("2026-01-05")
	cend, _ := model.ParseDate("2026-01-10")
	if _, err := testStore.CreateItem(ctx, lane.ID, store.NewItem{
		Title: "Child", StartDate: cstart, EndDate: cend, ParentID: &parent.ID}); err != nil {
		t.Fatal(err)
	}
	msdate, _ := model.ParseDate("2026-03-15")
	if _, err := testStore.CreateMilestone(ctx, lane.ID, store.NewMilestone{
		Title: "GA", Date: msdate}); err != nil {
		t.Fatal(err)
	}
	return rm.ID
}

func TestExportImportRoundTrip(t *testing.T) {
	id := seedRoadmap(t, "test-"+t.Name())

	// Export.
	w := do(t, "GET", "/api/roadmaps/"+itoa(id)+"/export", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("export status: want 200, got %d (%s)", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("export content-type: %q", ct)
	}
	// exportFilename collapses the name's non-alphanumerics (here the hyphen).
	cd := w.Header().Get("Content-Disposition")
	if !strings.Contains(cd, `filename="test_TestExportImportRoundTrip.roadie.json"`) {
		t.Errorf("export content-disposition: %q", cd)
	}
	var exp model.RoadmapExport
	if err := json.Unmarshal(w.Body.Bytes(), &exp); err != nil {
		t.Fatalf("export body: %v", err)
	}
	if exp.Format != model.ExportFormat || exp.Version != model.ExportVersion {
		t.Errorf("export envelope: format=%q version=%d", exp.Format, exp.Version)
	}
	if len(exp.Roadmap.Lanes) != 1 || len(exp.Roadmap.Lanes[0].Items) != 1 {
		t.Fatalf("export payload shape: %+v", exp.Roadmap.Lanes)
	}

	// Import the exact exported bytes: same name exists, so it must be
	// disambiguated with a " (2)" suffix.
	w = doRaw(t, "POST", "/api/roadmaps/import", w.Body.String())
	if w.Code != http.StatusCreated {
		t.Fatalf("import status: want 201, got %d (%s)", w.Code, w.Body.String())
	}
	var rm model.Roadmap
	if err := json.Unmarshal(w.Body.Bytes(), &rm); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })
	if rm.ID == id {
		t.Errorf("import reused source roadmap id")
	}
	if rm.Name != "test-"+t.Name()+" (2)" {
		t.Errorf("import name: got %q", rm.Name)
	}

	// The imported roadmap round-trips structurally.
	w = do(t, "GET", "/api/roadmaps/"+itoa(rm.ID), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get imported: %d", w.Code)
	}
	var full model.RoadmapFull
	if err := json.Unmarshal(w.Body.Bytes(), &full); err != nil {
		t.Fatal(err)
	}
	if len(full.Lanes) != 1 || len(full.Lanes[0].Items) != 1 ||
		len(full.Lanes[0].Items[0].Children) != 1 || len(full.Lanes[0].Milestones) != 1 {
		t.Errorf("imported structure not preserved: %+v", full.Lanes)
	}
}

func TestImportRejectsBadInput(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"malformed json", `{not json`},
		{"wrong format", `{"format":"something-else","version":1,"roadmap":{"name":"x"}}`},
		{"future version", `{"format":"roadie.roadmap","version":999,"roadmap":{"name":"x"}}`},
		{"empty name", `{"format":"roadie.roadmap","version":1,"roadmap":{"name":""}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := doRaw(t, "POST", "/api/roadmaps/import", tc.body)
			if w.Code != http.StatusBadRequest {
				t.Errorf("want 400, got %d (%s)", w.Code, w.Body.String())
			}
		})
	}
}

func TestDuplicateRoadmap(t *testing.T) {
	id := seedRoadmap(t, "test-"+t.Name())

	w := do(t, "POST", "/api/roadmaps/"+itoa(id)+"/duplicate", map[string]string{"name": "test-dup-" + t.Name()})
	if w.Code != http.StatusCreated {
		t.Fatalf("duplicate status: want 201, got %d (%s)", w.Code, w.Body.String())
	}
	var copyRM model.Roadmap
	if err := json.Unmarshal(w.Body.Bytes(), &copyRM); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), copyRM.ID) })
	if copyRM.ID == id {
		t.Errorf("duplicate reused source roadmap id")
	}
	if copyRM.Name != "test-dup-"+t.Name() {
		t.Errorf("duplicate name: got %q", copyRM.Name)
	}

	// The copy has the same structure but shares no IDs with the source.
	src := getFull(t, id)
	dup := getFull(t, copyRM.ID)
	if len(dup.Lanes) != 1 || len(dup.Lanes[0].Items) != 1 ||
		len(dup.Lanes[0].Items[0].Children) != 1 || len(dup.Lanes[0].Milestones) != 1 {
		t.Fatalf("duplicate structure not preserved: %+v", dup.Lanes)
	}
	if dup.Lanes[0].ID == src.Lanes[0].ID {
		t.Errorf("duplicate reused lane id %d", dup.Lanes[0].ID)
	}
	if dup.Lanes[0].Items[0].ID == src.Lanes[0].Items[0].ID {
		t.Errorf("duplicate reused item id %d", dup.Lanes[0].Items[0].ID)
	}
	if dup.Lanes[0].Milestones[0].ID == src.Lanes[0].Milestones[0].ID {
		t.Errorf("duplicate reused milestone id %d", dup.Lanes[0].Milestones[0].ID)
	}
	// The child must hang off the copy's parent, not the source's.
	if pid := dup.Lanes[0].Items[0].Children[0].ParentID; pid == nil || *pid != dup.Lanes[0].Items[0].ID {
		t.Errorf("duplicate child parentId: got %v, want %d", pid, dup.Lanes[0].Items[0].ID)
	}

	// Editing the copy must not touch the source.
	w = do(t, "PATCH", "/api/items/"+itoa(dup.Lanes[0].Items[0].ID), map[string]string{"title": "Renamed"})
	if w.Code != http.StatusOK {
		t.Fatalf("patch copy item: %d (%s)", w.Code, w.Body.String())
	}
	if got := getFull(t, id).Lanes[0].Items[0].Title; got != "Parent" {
		t.Errorf("source item changed with the copy: %q", got)
	}
}

// TestDuplicateRoadmapDefaultName checks that an omitted name falls back to the
// source's, disambiguated by the store's " (n)" suffix.
func TestDuplicateRoadmapDefaultName(t *testing.T) {
	id := seedRoadmap(t, "test-"+t.Name())

	w := do(t, "POST", "/api/roadmaps/"+itoa(id)+"/duplicate", map[string]string{})
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
	}
	var copyRM model.Roadmap
	if err := json.Unmarshal(w.Body.Bytes(), &copyRM); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), copyRM.ID) })
	if copyRM.Name != "test-"+t.Name()+" (2)" {
		t.Errorf("default duplicate name: got %q", copyRM.Name)
	}
}

func TestDuplicateMissingRoadmap(t *testing.T) {
	w := do(t, "POST", "/api/roadmaps/999999999/duplicate", map[string]string{})
	if w.Code != http.StatusNotFound {
		t.Errorf("want 404, got %d", w.Code)
	}
}

// getFull fetches a roadmap through the API and decodes it.
func getFull(t *testing.T, id int64) model.RoadmapFull {
	t.Helper()
	w := do(t, "GET", "/api/roadmaps/"+itoa(id), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get roadmap %d: %d (%s)", id, w.Code, w.Body.String())
	}
	var full model.RoadmapFull
	if err := json.Unmarshal(w.Body.Bytes(), &full); err != nil {
		t.Fatal(err)
	}
	return full
}

func TestExportMissingRoadmap(t *testing.T) {
	w := do(t, "GET", "/api/roadmaps/999999999/export", nil)
	if w.Code != http.StatusNotFound {
		t.Errorf("want 404, got %d", w.Code)
	}
}

func itoa(i int64) string {
	return strconv.FormatInt(i, 10)
}
