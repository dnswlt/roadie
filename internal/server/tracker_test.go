package server

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"testing/fstest"

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
	})
}
