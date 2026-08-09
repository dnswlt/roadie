package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

func TestDependencyEndpoints(t *testing.T) {
	ctx := context.Background()
	id := seedRoadmap(t, "test-"+t.Name())
	full, err := testStore.GetRoadmapFull(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	lane := full.Lanes[0]
	item := lane.Items[0]
	ms := lane.Milestones[0]

	// Create: the milestone depends on the item.
	body := map[string]any{
		"from": map[string]any{"kind": "item", "id": item.ID},
		"to":   map[string]any{"kind": "milestone", "id": ms.ID},
	}
	w := do(t, "POST", "/api/roadmaps/"+itoa(id)+"/dependencies", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("create status: want 201, got %d (%s)", w.Code, w.Body.String())
	}
	var dep model.Dependency
	if err := json.Unmarshal(w.Body.Bytes(), &dep); err != nil {
		t.Fatal(err)
	}
	if dep.From.Kind != model.DepItem || dep.From.ID != item.ID ||
		dep.To.Kind != model.DepMilestone || dep.To.ID != ms.ID {
		t.Errorf("created edge: %+v", dep)
	}

	// The edge rides in the roadmap payload; there is no GET of its own.
	w = do(t, "GET", "/api/roadmaps/"+itoa(id), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get roadmap: %d", w.Code)
	}
	var rm model.RoadmapFull
	if err := json.Unmarshal(w.Body.Bytes(), &rm); err != nil {
		t.Fatal(err)
	}
	if len(rm.Dependencies) != 1 || rm.Dependencies[0].ID != dep.ID {
		t.Errorf("payload dependencies: %+v", rm.Dependencies)
	}

	// The reverse edge closes a cycle; the 400 must explain it in titles.
	reverse := map[string]any{
		"from": map[string]any{"kind": "milestone", "id": ms.ID},
		"to":   map[string]any{"kind": "item", "id": item.ID},
	}
	w = do(t, "POST", "/api/roadmaps/"+itoa(id)+"/dependencies", reverse)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("cycle status: want 400, got %d (%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "already depends on") {
		t.Errorf("cycle error body: %s", w.Body.String())
	}

	// Malformed body.
	w = doRaw(t, "POST", "/api/roadmaps/"+itoa(id)+"/dependencies", `{"from": 7}`)
	if w.Code != http.StatusBadRequest {
		t.Errorf("malformed body: want 400, got %d", w.Code)
	}

	// Delete, then the edge is gone — from the API and from the payload.
	w = do(t, "DELETE", "/api/dependencies/"+itoa(dep.ID), nil)
	if w.Code != http.StatusNoContent {
		t.Fatalf("delete status: want 204, got %d (%s)", w.Code, w.Body.String())
	}
	w = do(t, "DELETE", "/api/dependencies/"+itoa(dep.ID), nil)
	if w.Code != http.StatusNotFound {
		t.Errorf("double delete: want 404, got %d", w.Code)
	}
}
