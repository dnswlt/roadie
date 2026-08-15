package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/dnswlt/roadie/internal/model"
	"github.com/dnswlt/roadie/internal/store"
	"github.com/dnswlt/roadie/internal/tracker"
)

type stubTracker struct {
	query, continuation string
	pageSize            int
	page                tracker.Page
	err                 error
}

func (s *stubTracker) Search(_ context.Context, query, continuation string, pageSize int) (tracker.Page, error) {
	s.query, s.continuation, s.pageSize = query, continuation, pageSize
	return s.page, s.err
}

func (s *stubTracker) GetIssue(context.Context, string) (tracker.Issue, error) {
	return tracker.Issue{}, errors.New("not implemented")
}

func TestTrackerSearch(t *testing.T) {
	stub := &stubTracker{page: tracker.Page{
		Issues: []tracker.Issue{{ID: "1", Key: "PAY-1", Title: "Payments", Type: "Epic", Status: "To Do", URL: "https://jira.test/browse/PAY-1"}},
		Next:   "100",
	}}
	srv := New(testStore, fstest.MapFS{}, WithTracker(stub))
	w := doWithServer(t, srv, http.MethodPost, "/api/tracker/search",
		trackerSearchRequest{Query: "project = PAY", Continuation: "50", PageSize: 25})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	if stub.query != "project = PAY" || stub.continuation != "50" || stub.pageSize != 25 {
		t.Fatalf("tracker call = query %q, continuation %q, pageSize %d", stub.query, stub.continuation, stub.pageSize)
	}
	got := decode[tracker.Page](t, w)
	if len(got.Issues) != 1 || got.Issues[0].Key != "PAY-1" || got.Next != "100" {
		t.Fatalf("page = %+v", got)
	}
}

func TestTrackerSearchDefaultsAndErrors(t *testing.T) {
	path := "/api/tracker/search"

	t.Run("default page size", func(t *testing.T) {
		stub := &stubTracker{}
		srv := New(testStore, fstest.MapFS{}, WithTracker(stub))
		w := doWithServer(t, srv, http.MethodPost, path, trackerSearchRequest{Query: "x"})
		if w.Code != http.StatusOK || stub.pageSize != defaultTrackerPageSize {
			t.Fatalf("status = %d, pageSize = %d, body %s", w.Code, stub.pageSize, w.Body)
		}
	})

	t.Run("page too large", func(t *testing.T) {
		stub := &stubTracker{}
		srv := New(testStore, fstest.MapFS{}, WithTracker(stub))
		w := doWithServer(t, srv, http.MethodPost, path, trackerSearchRequest{Query: "x", PageSize: 101})
		if w.Code != http.StatusBadRequest || stub.pageSize != 0 {
			t.Fatalf("status = %d, tracker called with %d, body %s", w.Code, stub.pageSize, w.Body)
		}
	})

	t.Run("not configured", func(t *testing.T) {
		w := do(t, http.MethodPost, path, trackerSearchRequest{Query: "x"})
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, body %s", w.Code, w.Body)
		}
	})

	t.Run("upstream failure", func(t *testing.T) {
		srv := New(testStore, fstest.MapFS{}, WithTracker(&stubTracker{err: errors.New("offline")}))
		w := doWithServer(t, srv, http.MethodPost, path, trackerSearchRequest{Query: "x"})
		if w.Code != http.StatusBadGateway {
			t.Fatalf("status = %d, body %s", w.Code, w.Body)
		}
		// The upstream's own words stay in the log: a deployment failure is
		// not something the person who typed the query can act on.
		if strings.Contains(w.Body.String(), "offline") {
			t.Fatalf("body leaks upstream detail: %s", w.Body)
		}
	})

	// A rejected query is the user's to fix, so the tracker's explanation has
	// to survive all the way into the response body.
	t.Run("rejected query", func(t *testing.T) {
		const msg = "Error in the JQL Query: Expecting operator but got 'AN'."
		srv := New(testStore, fstest.MapFS{}, WithTracker(&stubTracker{err: &tracker.QueryError{Message: msg}}))
		w := doWithServer(t, srv, http.MethodPost, path, trackerSearchRequest{Query: "project = PAY AN x"})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, body %s", w.Code, w.Body)
		}
		if got := decode[map[string]string](t, w)["error"]; got != msg {
			t.Fatalf("error = %q, want %q", got, msg)
		}
	})
}

// The saved-query routes are guarded CRUD over the store; this exercises the
// HTTP shape end to end — statuses, JSON, and the 404 for a vanished id.
func TestTrackerQueryRoutes(t *testing.T) {
	ctx := context.Background()
	rm, err := testStore.CreateRoadmap(ctx, "test-"+t.Name(), store.Ownership{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })
	base := "/api/roadmaps/" + itoa(rm.ID) + "/tracker-queries"

	w := do(t, http.MethodPost, base, trackerQueryRequest{Name: "Epics", Query: "type = Epic"})
	if w.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body %s", w.Code, w.Body)
	}
	q := decode[model.TrackerQuery](t, w)
	if q.Name != "Epics" || q.Query != "type = Epic" || q.RoadmapID != rm.ID {
		t.Fatalf("created = %+v", q)
	}

	if w := do(t, http.MethodPost, base, trackerQueryRequest{Name: "Epics", Query: "other"}); w.Code != http.StatusBadRequest {
		t.Fatalf("duplicate status = %d, body %s", w.Code, w.Body)
	}

	w = do(t, http.MethodPatch, "/api/tracker-queries/"+itoa(q.ID), map[string]string{"query": "type = Story"})
	if w.Code != http.StatusOK {
		t.Fatalf("patch status = %d, body %s", w.Code, w.Body)
	}
	if got := decode[model.TrackerQuery](t, w); got.Query != "type = Story" || got.Name != "Epics" {
		t.Fatalf("patched = %+v", got)
	}

	w = do(t, http.MethodGet, base, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d, body %s", w.Code, w.Body)
	}
	if list := decode[[]model.TrackerQuery](t, w); len(list) != 1 || list[0].Query != "type = Story" {
		t.Fatalf("list = %+v", list)
	}

	if w := do(t, http.MethodDelete, "/api/tracker-queries/"+itoa(q.ID), nil); w.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body %s", w.Code, w.Body)
	}
	// The guard resolves the vanished id to its roadmap and finds none: 404.
	if w := do(t, http.MethodPatch, "/api/tracker-queries/"+itoa(q.ID), map[string]string{"name": "x"}); w.Code != http.StatusNotFound {
		t.Fatalf("patch after delete = %d, body %s", w.Code, w.Body)
	}
}
