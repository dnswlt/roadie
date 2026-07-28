package server

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

// TestTrashRoutes walks the delete → trash → restore → delete → purge path the
// UI drives, and checks the two things only the HTTP layer decides: that
// /api/roadmaps/trash isn't swallowed by the {id} route, and that the purge
// countdown the client displays comes from the server's retention policy.
func TestTrashRoutes(t *testing.T) {
	id := seedRoadmap(t, "test-"+t.Name())

	if w := do(t, "DELETE", "/api/roadmaps/"+itoa(id), nil); w.Code != http.StatusNoContent {
		t.Fatalf("delete status: want 204, got %d (%s)", w.Code, w.Body.String())
	}

	// Gone from the live API...
	w := do(t, "GET", "/api/roadmaps/"+itoa(id), nil)
	if w.Code != http.StatusNotFound {
		t.Errorf("get trashed roadmap: want 404, got %d", w.Code)
	}
	w = do(t, "GET", "/api/roadmaps", nil)
	var live []model.Roadmap
	if err := json.Unmarshal(w.Body.Bytes(), &live); err != nil {
		t.Fatal(err)
	}
	for _, rm := range live {
		if rm.ID == id {
			t.Error("trashed roadmap still in the live listing")
		}
	}

	// ...and present in the trash, with the purge date the sweeper will act on.
	entry, ok := findTrash(t, id)
	if !ok {
		t.Fatal("deleted roadmap is not in the trash")
	}
	if entry.DeletedAt == nil {
		t.Fatal("trash entry has no deletion time")
	}
	if want := entry.DeletedAt.Add(trashTTL); !entry.PurgeAt.Equal(want) {
		t.Errorf("purgeAt: got %v, want %v", entry.PurgeAt, want)
	}

	// Restore brings it back, contents and all.
	if w := do(t, "POST", "/api/roadmaps/"+itoa(id)+"/restore", nil); w.Code != http.StatusOK {
		t.Fatalf("restore status: want 200, got %d (%s)", w.Code, w.Body.String())
	}
	w = do(t, "GET", "/api/roadmaps/"+itoa(id), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get restored roadmap: %d", w.Code)
	}
	var full model.RoadmapFull
	if err := json.Unmarshal(w.Body.Bytes(), &full); err != nil {
		t.Fatal(err)
	}
	if len(full.Lanes) != 1 || len(full.Lanes[0].Items) != 1 || len(full.Lanes[0].Milestones) != 1 {
		t.Errorf("restored structure: %+v", full.Lanes)
	}

	// A live roadmap can't be purged: permanent deletion always takes two steps.
	if w := do(t, "DELETE", "/api/roadmaps/"+itoa(id)+"/purge", nil); w.Code != http.StatusNotFound {
		t.Errorf("purge of a live roadmap: want 404, got %d", w.Code)
	}
	if w := do(t, "GET", "/api/roadmaps/"+itoa(id), nil); w.Code != http.StatusOK {
		t.Fatal("refused purge damaged the roadmap")
	}

	// Delete it again, then purge for real.
	if w := do(t, "DELETE", "/api/roadmaps/"+itoa(id), nil); w.Code != http.StatusNoContent {
		t.Fatalf("second delete: %d", w.Code)
	}
	if w := do(t, "DELETE", "/api/roadmaps/"+itoa(id)+"/purge", nil); w.Code != http.StatusNoContent {
		t.Fatalf("purge status: want 204, got %d (%s)", w.Code, w.Body.String())
	}
	if _, ok := findTrash(t, id); ok {
		t.Error("purged roadmap still in the trash")
	}
	if w := do(t, "POST", "/api/roadmaps/"+itoa(id)+"/restore", nil); w.Code != http.StatusNotFound {
		t.Errorf("restore of a purged roadmap: want 404, got %d", w.Code)
	}
}

// findTrash fetches the trash and returns the entry for id, if it is there.
func findTrash(t *testing.T, id int64) (trashEntry, bool) {
	t.Helper()
	w := do(t, "GET", "/api/roadmaps/trash", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list trash: want 200, got %d (%s)", w.Code, w.Body.String())
	}
	var entries []trashEntry
	if err := json.Unmarshal(w.Body.Bytes(), &entries); err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.ID == id {
			return e, true
		}
	}
	return trashEntry{}, false
}
