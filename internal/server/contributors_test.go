package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dnswlt/roadie/internal/auth"
	"github.com/dnswlt/roadie/internal/model"
)

// mutateAs runs a mutating request carrying id's identity. The test server runs
// with auth off, so no middleware populates the context — injecting the
// identity here is what a logged-in request looks like by the time it reaches
// the snap wrapper, which is the code under test.
func mutateAs(t *testing.T, id auth.Identity, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if !id.IsAnonymous() {
		r = r.WithContext(auth.WithIdentity(r.Context(), id))
	}
	w := httptest.NewRecorder()
	testSrv.ServeHTTP(w, r)
	return w
}

func contributorsOf(t *testing.T, roadmapID int64) []model.Contributor {
	t.Helper()
	w := do(t, "GET", fmt.Sprintf("/api/roadmaps/%d/contributors", roadmapID), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list contributors: status %d, body %s", w.Code, w.Body)
	}
	var got []model.Contributor
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatalf("decode contributors: %v", err)
	}
	return got
}

// Attribution rides on the snap wrapper, so any snap-wrapped route records the
// editor. This exercises the wiring end to end rather than the store call.
func TestMutationRecordsContributor(t *testing.T) {
	rmID := seedRoadmap(t, "Attribution")
	ada := auth.Identity{Subject: "sub-ada", Name: "Ada Lovelace", Email: "ada@example.com"}

	w := mutateAs(t, ada, "PATCH", fmt.Sprintf("/api/roadmaps/%d", rmID), `{"name":"Renamed"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("patch roadmap: status %d, body %s", w.Code, w.Body)
	}

	got := contributorsOf(t, rmID)
	if len(got) != 1 || got[0].Name != "Ada Lovelace" {
		t.Fatalf("want [Ada Lovelace], got %+v", got)
	}
	// The OIDC subject is a row key, not something the browser needs.
	if strings.Contains(w.Body.String(), "sub-ada") {
		t.Errorf("response leaked the subject id: %s", w.Body)
	}
}

// A failed mutation must not credit anyone: the snap wrapper only attributes
// after a 2xx, the same gate the SSE broadcast uses.
func TestFailedMutationRecordsNoContributor(t *testing.T) {
	rmID := seedRoadmap(t, "No credit for failures")
	ada := auth.Identity{Subject: "sub-ada", Name: "Ada Lovelace"}

	// An empty name is rejected by the store as a validation error.
	w := mutateAs(t, ada, "PATCH", fmt.Sprintf("/api/roadmaps/%d", rmID), `{"name":""}`)
	if w.Code < 400 {
		t.Fatalf("want a client error for an empty name, got status %d", w.Code)
	}
	if got := contributorsOf(t, rmID); len(got) != 0 {
		t.Fatalf("failed mutation was attributed: %+v", got)
	}
}

// Creating a roadmap is not snap-wrapped (there is no id to resolve before the
// handler runs), so it attributes explicitly. Without this the creator would
// only appear once they edited something inside the roadmap.
func TestCreateRoadmapRecordsContributor(t *testing.T) {
	ada := auth.Identity{Subject: "sub-ada", Name: "Ada Lovelace"}

	w := mutateAs(t, ada, "POST", "/api/roadmaps", `{"name":"Created by Ada"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("create roadmap: status %d, body %s", w.Code, w.Body)
	}
	var rm model.Roadmap
	if err := json.NewDecoder(w.Body).Decode(&rm); err != nil {
		t.Fatalf("decode roadmap: %v", err)
	}
	t.Cleanup(func() { _ = testStore.DeleteRoadmap(context.Background(), rm.ID) })

	if got := contributorsOf(t, rm.ID); len(got) != 1 || got[0].Name != "Ada Lovelace" {
		t.Fatalf("creator not recorded: %+v", got)
	}
}

// Duplicating credits the copy, not the source. The path id is the source
// roadmap, so getting this wrong is easy and silent.
func TestDuplicateRoadmapRecordsContributorOnCopy(t *testing.T) {
	srcID := seedRoadmap(t, "Duplication source")
	grace := auth.Identity{Subject: "sub-grace", Name: "Grace Hopper"}

	w := mutateAs(t, grace, "POST", fmt.Sprintf("/api/roadmaps/%d/duplicate", srcID), `{"name":"The copy"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("duplicate: status %d, body %s", w.Code, w.Body)
	}
	var copyRM model.Roadmap
	if err := json.NewDecoder(w.Body).Decode(&copyRM); err != nil {
		t.Fatalf("decode roadmap: %v", err)
	}
	t.Cleanup(func() { _ = testStore.DeleteRoadmap(context.Background(), copyRM.ID) })

	if got := contributorsOf(t, copyRM.ID); len(got) != 1 || got[0].Name != "Grace Hopper" {
		t.Fatalf("copy not attributed to whoever made it: %+v", got)
	}
	if got := contributorsOf(t, srcID); len(got) != 0 {
		t.Fatalf("duplicating credited the source roadmap: %+v", got)
	}
}

// With auth off every request is anonymous, so nothing is recorded and the
// contributor list stays empty — which is what makes the UI hide it entirely.
func TestAnonymousMutationRecordsNoContributor(t *testing.T) {
	rmID := seedRoadmap(t, "Open mode")

	w := mutateAs(t, auth.Identity{}, "PATCH", fmt.Sprintf("/api/roadmaps/%d", rmID), `{"name":"Renamed"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("patch roadmap: status %d, body %s", w.Code, w.Body)
	}
	if got := contributorsOf(t, rmID); len(got) != 0 {
		t.Fatalf("anonymous edit was attributed: %+v", got)
	}
}
