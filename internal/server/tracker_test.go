package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/dnswlt/roadie/internal/model"
	"github.com/dnswlt/roadie/internal/recon"
	"github.com/dnswlt/roadie/internal/store"
	"github.com/dnswlt/roadie/internal/tracker"
)

type stubTracker struct {
	query, continuation string
	pageSize            int
	page                tracker.Page
	err                 error
	baseURL             string
}

func (s *stubTracker) Search(_ context.Context, query, continuation string, pageSize int) (tracker.Page, error) {
	s.query, s.continuation, s.pageSize = query, continuation, pageSize
	return s.page, s.err
}

func (s *stubTracker) GetIssue(context.Context, string) (tracker.Issue, error) {
	return tracker.Issue{}, errors.New("not implemented")
}

func (s *stubTracker) FetchIssues(context.Context, []string, []string) ([]tracker.FetchedIssue, error) {
	return nil, errors.New("not implemented")
}

func (s *stubTracker) BaseURL() string { return s.baseURL }

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

// The extractor routes are guarded CRUD plus one thing the store cannot do:
// refuse a script that will not run. testSrv has no tracker configured, which
// is the point — a script is editable while the connection is down.
func TestTrackerExtractorRoutes(t *testing.T) {
	ctx := context.Background()
	rm, err := testStore.CreateRoadmap(ctx, "test-"+t.Name(), store.Ownership{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })
	path := "/api/roadmaps/" + itoa(rm.ID) + "/tracker-extractor"

	if w := do(t, http.MethodGet, path, nil); w.Code != http.StatusNotFound {
		t.Fatalf("get before put = %d, body %s", w.Code, w.Body)
	}

	const src = "JIRA_FIELDS = [\"fixVersions\"]\n\ndef get_issue_time_range(issue):\n    return None\n"
	w := do(t, http.MethodPut, path, trackerExtractorRequest{Source: src})
	if w.Code != http.StatusOK {
		t.Fatalf("put status = %d, body %s", w.Code, w.Body)
	}
	if got := decode[model.TrackerExtractor](t, w); got.Source != src || got.RoadmapID != rm.ID {
		t.Fatalf("put = %+v", got)
	}
	if got := decode[model.TrackerExtractor](t, do(t, http.MethodGet, path, nil)); got.Source != src {
		t.Fatalf("get = %+v", got)
	}

	// A script that cannot run is never stored, and the response says where.
	for name, bad := range map[string]string{
		"syntax error":   "def get_issue_time_range(issue)\n",
		"no entry point": "JIRA_FIELDS = [\"duedate\"]\n",
		"bad fields":     "JIRA_FIELDS = \"duedate\"\ndef get_issue_time_range(issue):\n    return None\n",
	} {
		w := do(t, http.MethodPut, path, trackerExtractorRequest{Source: bad})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, body %s", name, w.Code, w.Body)
		}
		if msg := decode[map[string]string](t, w)["error"]; msg == "" {
			t.Fatalf("%s: no message", name)
		}
	}
	if got := decode[model.TrackerExtractor](t, do(t, http.MethodGet, path, nil)); got.Source != src {
		t.Fatalf("a rejected put changed the stored script: %+v", got)
	}

	if w := do(t, http.MethodDelete, path, nil); w.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body %s", w.Code, w.Body)
	}
	if w := do(t, http.MethodDelete, path, nil); w.Code != http.StatusNotFound {
		t.Fatalf("second delete = %d, body %s", w.Code, w.Body)
	}
}

// reconTracker answers one issue, so the routes can be exercised end to end.
// It records the fields it was asked for: what a script declares has to reach
// the adapter, or a custom field would come back missing for the wrong reason.
type reconTracker struct {
	stubTracker
	fields []string
}

func (t *reconTracker) FetchIssues(_ context.Context, keys, extraFields []string) ([]tracker.FetchedIssue, error) {
	t.fields = extraFields
	var out []tracker.FetchedIssue
	for _, key := range keys {
		if key == "PAY-1" {
			out = append(out, tracker.FetchedIssue{
				Issue: tracker.Issue{ID: "1", Key: "PAY-1", Title: "Payments"},
				Raw:   map[string]any{"key": "PAY-1", "fields": map[string]any{"duedate": "2026-04-12"}},
			})
		}
	}
	return out, nil
}

// Test is the editor's own path: it runs the source in the body, never the
// stored one, and answers with a result to render rather than an error status.
func TestTrackerExtractorTestRoute(t *testing.T) {
	rm := seedRoadmap(t, "test-"+t.Name())
	stub := &reconTracker{}
	srv := New(testStore, fstest.MapFS{}, WithTracker(stub))
	path := "/api/roadmaps/" + itoa(rm) + "/tracker-extractor/test"
	const src = "JIRA_FIELDS = [\"duedate\"]\n\n" +
		"def get_issue_time_range(issue):\n" +
		"    print(\"seen\", issue[\"key\"])\n" +
		"    return {\"end\": issue[\"fields\"][\"duedate\"], \"label\": \"Due date\"}\n"

	w := doWithServer(t, srv, http.MethodPost, path, trackerExtractorTestRequest{Source: src, Key: "pay-1"})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	got := decode[trackerExtractorTestResponse](t, w)
	if got.State != recon.StateOK || got.End != "2026-04-12" || got.Label != "Due date" {
		t.Fatalf("result = %+v", got)
	}
	if len(stub.fields) != 1 || stub.fields[0] != "duedate" {
		t.Fatalf("fields asked of the tracker = %v", stub.fields)
	}
	// The raw issue is what makes a custom field's id discoverable, so it has
	// to be the script's argument verbatim — and print() has to come back with
	// it, since the editor is the only place a script's output is readable.
	if fields, _ := got.Raw["fields"].(map[string]any); fields["duedate"] != "2026-04-12" {
		t.Fatalf("raw = %+v", got.Raw)
	}
	if got.Issue == nil || got.Issue.Key != "PAY-1" {
		t.Fatalf("issue = %+v", got.Issue)
	}
	if len(got.Output) != 1 || got.Output[0] != "seen PAY-1" {
		t.Fatalf("output = %v", got.Output)
	}
	const periodSrc = "def get_issue_time_range(issue):\n" +
		"    return {\"startPeriod\": \"PI2026-09\", \"endPeriod\": \"PI2026-09\"}\n"
	w = doWithServer(t, srv, http.MethodPost, path, trackerExtractorTestRequest{Source: periodSrc, Key: "PAY-1"})
	got = decode[trackerExtractorTestResponse](t, w)
	if w.Code != http.StatusOK || got.State != recon.StateOK || got.Start != "" || got.End != "" || got.StartPeriod != "PI2026-09" || got.EndPeriod != "PI2026-09" {
		t.Fatalf("period result = %d, %+v", w.Code, got)
	}
	// Nothing was stored: Test precedes Save, and may run a script Save would
	// reject.
	if w := doWithServer(t, srv, http.MethodGet, "/api/roadmaps/"+itoa(rm)+"/tracker-extractor", nil); w.Code != http.StatusNotFound {
		t.Fatalf("get after test = %d, body %s", w.Code, w.Body)
	}

	// A key the tracker does not return is a state, not a failure.
	w = doWithServer(t, srv, http.MethodPost, path, trackerExtractorTestRequest{Source: src, Key: "PAY-404"})
	if w.Code != http.StatusOK || decode[trackerExtractorTestResponse](t, w).State != recon.StateNotFound {
		t.Fatalf("unknown key = %d, body %s", w.Code, w.Body)
	}
	w = doWithServer(t, srv, http.MethodPost, path, trackerExtractorTestRequest{Source: src, Key: " PAY-1 "})
	if w.Code != http.StatusOK || decode[trackerExtractorTestResponse](t, w).State != recon.StateNotFound {
		t.Fatalf("padded key = %d, body %s", w.Code, w.Body)
	}

	// A raising script is one too: the message names the line to fix.
	raising := "def get_issue_time_range(issue):\n    return issue[\"fields\"][\"nope\"]\n"
	w = doWithServer(t, srv, http.MethodPost, path, trackerExtractorTestRequest{Source: raising, Key: "PAY-1"})
	if w.Code != http.StatusOK {
		t.Fatalf("raising script = %d, body %s", w.Code, w.Body)
	}
	if got := decode[trackerExtractorTestResponse](t, w); got.State != recon.StateError || !strings.Contains(got.Error, "extractor.star:2") {
		t.Fatalf("raising script = %+v", got)
	}

	// Flagged, but still tested: the raw JSON is what the panel is for.
	scoped := "JIRA_PROJECTS = [\"OPS\"]\n" + src
	w = doWithServer(t, srv, http.MethodPost, path, trackerExtractorTestRequest{Source: scoped, Key: "PAY-1"})
	got = decode[trackerExtractorTestResponse](t, w)
	if w.Code != http.StatusOK || !got.OutOfScope || got.State != recon.StateOK || got.Raw == nil {
		t.Fatalf("out-of-scope key = %d, %+v", w.Code, got)
	}
	w = doWithServer(t, srv, http.MethodPost, path,
		trackerExtractorTestRequest{Source: "JIRA_PROJECTS = [\"PAY\"]\n" + src, Key: "PAY-1"})
	if got = decode[trackerExtractorTestResponse](t, w); got.OutOfScope {
		t.Fatalf("in-scope key = %+v", got)
	}

	// A script that does not compile is a 400 here exactly as it is on save,
	// and so is a test with no issue named.
	for name, req := range map[string]trackerExtractorTestRequest{
		"does not compile": {Source: "def get_issue_time_range(issue)\n", Key: "PAY-1"},
		"no entry point":   {Source: "JIRA_FIELDS = []\n", Key: "PAY-1"},
		"bad project":      {Source: "JIRA_PROJECTS = [\"PAY-1\"]\n" + src, Key: "PAY-1"},
		"no key":           {Source: src, Key: ""},
	} {
		if w := doWithServer(t, srv, http.MethodPost, path, req); w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, body %s", name, w.Code, w.Body)
		}
	}
}

// Without a tracker there is nothing to test a script against, and the answer
// says so rather than falling through to the SPA.
func TestTrackerExtractorTestWithoutTracker(t *testing.T) {
	rm := seedRoadmap(t, "test-"+t.Name())
	w := do(t, http.MethodPost, "/api/roadmaps/"+itoa(rm)+"/tracker-extractor/test",
		trackerExtractorTestRequest{Source: "def get_issue_time_range(issue):\n    return None\n", Key: "PAY-1"})
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
}

// The two routes are a thin layer over internal/recon: enqueue takes keys and
// returns at once, status answers from what has been established. Neither is
// allowed to be where the logic lives.
func TestScheduleCheckRoutes(t *testing.T) {
	ctx := context.Background()
	rm, err := testStore.CreateRoadmap(ctx, "test-"+t.Name(), store.Ownership{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })
	if _, err := testStore.PutTrackerExtractor(ctx, rm.ID,
		"JIRA_FIELDS = [\"duedate\"]\n\ndef get_issue_time_range(issue):\n"+
			"    return {\"end\": issue[\"fields\"][\"duedate\"]}\n"); err != nil {
		t.Fatal(err)
	}

	fetcher := recon.New(&reconTracker{}, func(ctx context.Context, id int64) (string, error) {
		ext, err := testStore.GetTrackerExtractor(ctx, id)
		return ext.Source, err
	}, 0)
	srv := New(testStore, fstest.MapFS{}, WithRecon(fetcher))
	base := "/api/roadmaps/" + itoa(rm.ID) + "/schedule-check"

	// No result is cached before anything is enqueued.
	w := doWithServer(t, srv, http.MethodPost, base+"/status", scheduleCheckRequest{Keys: []string{"pay-1", "PAY-1"}})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	got := decode[recon.Status](t, w)
	// Repeats collapse, so one key is one row.
	if len(got.Results) != 1 || got.Results[0].Key != "PAY-1" || got.Results[0].State != recon.StateUnchecked {
		t.Fatalf("before enqueue: %+v", got)
	}

	w = doWithServer(t, srv, http.MethodPost, base, scheduleCheckRequest{Keys: []string{"pay-1"}})
	if w.Code != http.StatusAccepted {
		t.Fatalf("enqueue status = %d, body %s", w.Code, w.Body)
	}
	enqueued := decode[map[string]int](t, w)
	if enqueued["queued"] != 1 || enqueued["pending"] != 1 {
		t.Fatalf("enqueue response = %v", enqueued)
	}

	w = doWithServer(t, srv, http.MethodPost, base+"/status", scheduleCheckRequest{Keys: []string{"pay-1"}})
	got = decode[recon.Status](t, w)
	if got.Pending != 1 {
		t.Fatalf("pending before run = %d, want 1", got.Pending)
	}

	// Run the one goroutine long enough to drain what was just enqueued.
	runCtx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { fetcher.Run(runCtx); close(done) }()
	deadline := time.After(5 * time.Second)
	for {
		w = doWithServer(t, srv, http.MethodPost, base+"/status", scheduleCheckRequest{Keys: []string{"pay-1"}})
		got = decode[recon.Status](t, w)
		if got.Results[0].State != recon.StateUnchecked {
			break
		}
		select {
		case <-deadline:
			t.Fatal("the fetcher never answered")
		case <-time.After(2 * time.Millisecond):
		}
	}
	cancel()
	<-done
	w = doWithServer(t, srv, http.MethodPost, base+"/status", scheduleCheckRequest{Keys: []string{"pay-1"}})
	got = decode[recon.Status](t, w)

	if got.Results[0].State != recon.StateOK || got.Results[0].End != "2026-04-12" || got.Results[0].CheckedAt.IsZero() {
		t.Fatalf("after the run: %+v", got.Results[0])
	}
	if got.Pending != 0 {
		t.Fatalf("pending after run = %d, want 0", got.Pending)
	}
}

func TestScheduleCheckRoutesWithoutRecon(t *testing.T) {
	rm := seedRoadmap(t, "test-"+t.Name())
	base := "/api/roadmaps/" + itoa(rm) + "/schedule-check"
	// A disabled feature is an API response, not a fallthrough to the SPA.
	for _, path := range []string{base, base + "/status"} {
		if w := do(t, http.MethodPost, path, scheduleCheckRequest{Keys: []string{"PAY-1"}}); w.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: status = %d, body %s", path, w.Code, w.Body)
		}
	}
}

// No script is the state the Recon tab explains and offers to fix.
func TestScheduleCheckStatusWithoutScript(t *testing.T) {
	ctx := context.Background()
	rm, err := testStore.CreateRoadmap(ctx, "test-"+t.Name(), store.Ownership{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testStore.DeleteRoadmap(context.Background(), rm.ID) })

	fetcher := recon.New(&reconTracker{}, func(ctx context.Context, id int64) (string, error) {
		ext, err := testStore.GetTrackerExtractor(ctx, id)
		return ext.Source, err
	}, 0)
	srv := New(testStore, fstest.MapFS{}, WithRecon(fetcher))
	w := doWithServer(t, srv, http.MethodPost,
		"/api/roadmaps/"+itoa(rm.ID)+"/schedule-check/status", scheduleCheckRequest{Keys: []string{"PAY-1"}})
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
}
