package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

func decode[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %T: %v (body: %s)", v, err, w.Body.String())
	}
	return v
}

func listSnaps(t *testing.T, roadmapID int64) []model.Snapshot {
	t.Helper()
	w := do(t, http.MethodGet, "/api/roadmaps/"+itoa(roadmapID)+"/snapshots", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list snapshots: status %d (%s)", w.Code, w.Body.String())
	}
	return decode[[]model.Snapshot](t, w)
}

func TestSnapshotEndpoints(t *testing.T) {
	id := seedRoadmap(t, "test-"+t.Name())

	// A throttled mutation with no prior snapshot captures the pre-mutation
	// state (the seeded roadmap, before the new lane is added).
	if w := do(t, http.MethodPost, "/api/roadmaps/"+itoa(id)+"/lanes", nameReq{Name: "New lane"}); w.Code != http.StatusCreated {
		t.Fatalf("add lane: status %d (%s)", w.Code, w.Body.String())
	}

	snaps := listSnaps(t, id)
	if len(snaps) != 1 {
		t.Fatalf("snapshots after first edit: want 1, got %d", len(snaps))
	}
	if snaps[0].Kind != model.SnapshotAuto || snaps[0].Name != nil {
		t.Errorf("unexpected snapshot metadata: %+v", snaps[0])
	}

	// The snapshot payload holds the pre-add state: a single "Backend" lane.
	w := do(t, http.MethodGet, "/api/snapshots/"+itoa(snaps[0].ID), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get snapshot: status %d (%s)", w.Code, w.Body.String())
	}
	snapFull := decode[model.RoadmapFull](t, w)
	if len(snapFull.Lanes) != 1 || snapFull.Lanes[0].Name != "Backend" {
		t.Fatalf("snapshot contents: want [Backend], got %d lanes", len(snapFull.Lanes))
	}

	// Restore rolls back the new lane and records a pre-restore snapshot.
	if w := do(t, http.MethodPost, "/api/snapshots/"+itoa(snaps[0].ID)+"/restore", nil); w.Code != http.StatusOK {
		t.Fatalf("restore: status %d (%s)", w.Code, w.Body.String())
	}
	w = do(t, http.MethodGet, "/api/roadmaps/"+itoa(id), nil)
	live := decode[model.RoadmapFull](t, w)
	if len(live.Lanes) != 1 || live.Lanes[0].Name != "Backend" {
		t.Fatalf("after restore: want [Backend], got %d lanes", len(live.Lanes))
	}
	if snaps = listSnaps(t, id); len(snaps) != 2 {
		t.Fatalf("snapshots after restore: want 2, got %d", len(snaps))
	}

	// Deleting a snapshot removes just that one.
	if w := do(t, http.MethodDelete, "/api/snapshots/"+itoa(snaps[0].ID), nil); w.Code != http.StatusNoContent {
		t.Fatalf("delete snapshot: status %d (%s)", w.Code, w.Body.String())
	}
	if snaps = listSnaps(t, id); len(snaps) != 1 {
		t.Fatalf("snapshots after delete: want 1, got %d", len(snaps))
	}

	// Errors.
	if w := do(t, http.MethodGet, "/api/snapshots/0", nil); w.Code != http.StatusNotFound {
		t.Errorf("get missing snapshot: want 404, got %d", w.Code)
	}
	if w := do(t, http.MethodPost, "/api/snapshots/0/restore", nil); w.Code != http.StatusNotFound {
		t.Errorf("restore missing snapshot: want 404, got %d", w.Code)
	}
	if w := do(t, http.MethodGet, "/api/roadmaps/0/snapshots", nil); w.Code != http.StatusNotFound {
		t.Errorf("list snapshots of missing roadmap: want 404, got %d", w.Code)
	}
}

// TestAutoSnapshotPolicy checks the capture policy wired into the route table:
// throttled edits collapse to one snapshot per interval, while destructive
// edits force a capture regardless, and an unresolvable target captures nothing.
func TestAutoSnapshotPolicy(t *testing.T) {
	id := seedRoadmap(t, "test-"+t.Name())

	// Two throttled edits in quick succession -> only the first snapshots.
	if w := do(t, http.MethodPatch, "/api/roadmaps/"+itoa(id), nameReq{Name: "Renamed once"}); w.Code != http.StatusOK {
		t.Fatalf("rename 1: status %d (%s)", w.Code, w.Body.String())
	}
	if w := do(t, http.MethodPatch, "/api/roadmaps/"+itoa(id), nameReq{Name: "Renamed twice"}); w.Code != http.StatusOK {
		t.Fatalf("rename 2: status %d (%s)", w.Code, w.Body.String())
	}
	if snaps := listSnaps(t, id); len(snaps) != 1 {
		t.Fatalf("throttled edits: want 1 snapshot, got %d", len(snaps))
	}

	// A destructive edit forces a capture even within the throttle window.
	live := decode[model.RoadmapFull](t, do(t, http.MethodGet, "/api/roadmaps/"+itoa(id), nil))
	itemID := live.Lanes[0].Items[0].ID
	if w := do(t, http.MethodDelete, "/api/items/"+itoa(itemID), nil); w.Code != http.StatusNoContent {
		t.Fatalf("delete item: status %d (%s)", w.Code, w.Body.String())
	}
	if snaps := listSnaps(t, id); len(snaps) != 2 {
		t.Fatalf("after forced capture: want 2 snapshots, got %d", len(snaps))
	}

	// A delete that resolves to no roadmap (missing item) captures nothing and 404s.
	if w := do(t, http.MethodDelete, "/api/items/0", nil); w.Code != http.StatusNotFound {
		t.Errorf("delete missing item: want 404, got %d", w.Code)
	}
	if snaps := listSnaps(t, id); len(snaps) != 2 {
		t.Errorf("snapshots after no-op delete: want 2, got %d", len(snaps))
	}
}

// TestAutoSnapshotCollapsesBurst fires many PATCHes at once, as the client does
// when moving a parent with its children or shifting a multi-selection. The
// in-process debounce (claiming the window before capturing) must collapse them
// into a single snapshot rather than one per request.
func TestAutoSnapshotCollapsesBurst(t *testing.T) {
	id := seedRoadmap(t, "test-"+t.Name())
	live := decode[model.RoadmapFull](t, do(t, http.MethodGet, "/api/roadmaps/"+itoa(id), nil))
	itemID := live.Lanes[0].Items[0].ID

	const n = 8
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body, _ := json.Marshal(map[string]string{"title": "T" + itoa(int64(i))})
			r := httptest.NewRequest(http.MethodPatch, "/api/items/"+itoa(itemID), bytes.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			testSrv.ServeHTTP(w, r)
			if w.Code != http.StatusOK {
				t.Errorf("patch %d: status %d (%s)", i, w.Code, w.Body.String())
			}
		}(i)
	}
	wg.Wait()

	if snaps := listSnaps(t, id); len(snaps) != 1 {
		t.Fatalf("concurrent burst: want 1 snapshot, got %d", len(snaps))
	}
}
