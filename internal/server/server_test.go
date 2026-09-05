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
	return doWithServer(t, testSrv, method, path, body)
}

func doWithServer(t *testing.T, srv *Server, method, path string, body any) *httptest.ResponseRecorder {
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
	srv.ServeHTTP(w, r)
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
	rm, err := testStore.CreateRoadmap(ctx, name, store.Ownership{})
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

func TestMilestoneMetadataAPI(t *testing.T) {
	ctx := context.Background()
	rm, err := testStore.CreateRoadmap(ctx, "test-"+t.Name(), store.Ownership{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })
	lane, err := testStore.CreateLane(ctx, rm.ID, "Backend")
	if err != nil {
		t.Fatal(err)
	}

	w := do(t, http.MethodPost, "/api/lanes/"+itoa(lane.ID)+"/milestones", map[string]any{
		"title": "Launch", "date": "2026-03-15", "tentative": true,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("create status: want 201, got %d (%s)", w.Code, w.Body.String())
	}
	var milestone model.Milestone
	if err := json.Unmarshal(w.Body.Bytes(), &milestone); err != nil {
		t.Fatal(err)
	}
	if len(milestone.Labels) != 0 || milestone.Flagged || !milestone.Tentative || milestone.AtRisk {
		t.Fatalf("create response has unexpected metadata: %+v", milestone)
	}

	w = do(t, http.MethodPatch, "/api/milestones/"+itoa(milestone.ID), map[string]any{
		"labels": []string{" release ", "@team"}, "flagged": true, "atRisk": true,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("patch status: want 200, got %d (%s)", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &milestone); err != nil {
		t.Fatal(err)
	}
	if len(milestone.Labels) != 2 || milestone.Labels[0] != "release" || milestone.Labels[1] != "@team" ||
		!milestone.Flagged || !milestone.Tentative || !milestone.AtRisk {
		t.Fatalf("patch response lost metadata: %+v", milestone)
	}

	w = do(t, http.MethodPatch, "/api/milestones/"+itoa(milestone.ID), map[string]any{
		"labels": []string{}, "flagged": false, "tentative": false, "atRisk": false,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("clear status: want 200, got %d (%s)", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &milestone); err != nil {
		t.Fatal(err)
	}
	if len(milestone.Labels) != 0 || milestone.Flagged || milestone.Tentative || milestone.AtRisk {
		t.Fatalf("patch response did not clear metadata: %+v", milestone)
	}
	full := getFull(t, rm.ID)
	if len(full.Lanes) != 1 || len(full.Lanes[0].Milestones) != 1 {
		t.Fatalf("roadmap read lost milestone: %+v", full.Lanes)
	}
	got := full.Lanes[0].Milestones[0]
	if len(got.Labels) != 0 || got.Flagged || got.Tentative || got.AtRisk {
		t.Fatalf("roadmap read did not reflect patched metadata: %+v", got)
	}
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
		{"wrong format", `{"format":"something-else","version":2,"roadmap":{"name":"x"}}`},
		{"future version", `{"format":"roadie.roadmap","version":999,"roadmap":{"name":"x"}}`},
		{"past version", `{"format":"roadie.roadmap","version":1,"roadmap":{"name":"x"}}`},
		{"empty name", `{"format":"roadie.roadmap","version":2,"roadmap":{"name":""}}`},
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

// A UID is immutable from creation, so no patch may carry one. Nothing enforces
// that at runtime: the patch structs simply have no such field, and readJSON
// rejects unknown ones — which is exactly the guarantee, and why it is worth
// pinning that adding the field later would break this test rather than the
// identity.
func TestPatchCannotSetUID(t *testing.T) {
	id := seedRoadmap(t, "test-"+t.Name())

	w := do(t, "GET", "/api/roadmaps/"+itoa(id), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get roadmap: %d", w.Code)
	}
	full := decode[model.RoadmapFull](t, w)
	ms := full.Lanes[0].Milestones[0]
	if !strings.Contains(w.Body.String(), ms.UID) || ms.UID == "" {
		t.Fatalf("roadmap read does not carry the milestone UID: %+v", ms)
	}

	const fresh = `"0b3f4b0e-5b3a-4f2a-9c1d-7e6a5c4b3a21"`
	for _, tc := range []struct{ path, body string }{
		{"/api/milestones/" + itoa(ms.ID), `{"uid":` + fresh + `}`},
		{"/api/roadmaps/" + itoa(id), `{"uid":` + fresh + `}`},
	} {
		if w := doRaw(t, "PATCH", tc.path, tc.body); w.Code != http.StatusBadRequest {
			t.Errorf("PATCH %s with a uid: want 400, got %d (%s)", tc.path, w.Code, w.Body.String())
		}
	}
}

// The two import routes are two operations, not one with a flag: the same file
// posted to /import twice gives two unrelated roadmaps, and /transfer refuses an
// identity that is already here rather than quietly downgrading to a copy.
func TestImportModes(t *testing.T) {
	id := seedRoadmap(t, "test-"+t.Name())

	w := do(t, "GET", "/api/roadmaps/"+itoa(id)+"/export", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("export status: %d (%s)", w.Code, w.Body.String())
	}
	file := w.Body.String()

	var exp model.RoadmapExport
	if err := json.Unmarshal([]byte(file), &exp); err != nil {
		t.Fatal(err)
	}
	if exp.Roadmap.UID == "" || exp.Roadmap.Lanes[0].Milestones[0].UID == "" {
		t.Fatalf("export carries no identities: %+v", exp.Roadmap)
	}

	// Import: a new identity of its own.
	w = doRaw(t, "POST", "/api/roadmaps/import", file)
	if w.Code != http.StatusCreated {
		t.Fatalf("import: want 201, got %d (%s)", w.Code, w.Body.String())
	}
	copied := decode[model.Roadmap](t, w)
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), copied.ID) })
	if copied.UID == exp.Roadmap.UID {
		t.Errorf("import kept the roadmap UID %q", copied.UID)
	}

	// Transfer, while the source is still here: refused, and nothing written.
	w = doRaw(t, "POST", "/api/roadmaps/transfer", file)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("conflicting transfer: want 400, got %d (%s)", w.Code, w.Body.String())
	}

	// Transfer once the source is gone: the same logical roadmap arrives.
	if err := testStore.DeleteRoadmap(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	w = doRaw(t, "POST", "/api/roadmaps/transfer", file)
	if w.Code != http.StatusCreated {
		t.Fatalf("transfer: want 201, got %d (%s)", w.Code, w.Body.String())
	}
	moved := decode[model.Roadmap](t, w)
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), moved.ID) })
	if moved.UID != exp.Roadmap.UID {
		t.Errorf("transfer changed the roadmap UID: %q, want %q", moved.UID, exp.Roadmap.UID)
	}
}

// The route decides what an import does, so a mode cannot be smuggled past it:
// the identity is already here, and a transfer would have been refused.
func TestImportIgnoresAModeQueryParam(t *testing.T) {
	id := seedRoadmap(t, "test-"+t.Name())

	w := do(t, "GET", "/api/roadmaps/"+itoa(id)+"/export", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("export status: %d (%s)", w.Code, w.Body.String())
	}
	w = doRaw(t, "POST", "/api/roadmaps/import?mode=transfer", w.Body.String())
	if w.Code != http.StatusCreated {
		t.Fatalf("import with a stray query param: want 201, got %d (%s)", w.Code, w.Body.String())
	}
	rm := decode[model.Roadmap](t, w)
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })
}

// A file exported before UIDs existed carries no identity at all, and neither
// route accepts it. The format version decides that, not a scan of which UIDs
// happen to be populated.
func TestImportRejectsOldExport(t *testing.T) {
	const old = `{"format":"roadie.roadmap","version":1,"roadmap":{"name":"test-old-export","lanes":[]}}`

	for _, route := range []string{"/api/roadmaps/import", "/api/roadmaps/transfer"} {
		if w := doRaw(t, "POST", route, old); w.Code != http.StatusBadRequest {
			t.Errorf("v1 file to %s: want 400, got %d (%s)", route, w.Code, w.Body.String())
		}
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
