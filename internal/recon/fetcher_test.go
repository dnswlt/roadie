package recon

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dnswlt/roadie/internal/tracker"
)

// stubTracker records what the fetcher asked for and answers from a fixture.
type stubTracker struct {
	mu     sync.Mutex
	calls  int
	keys   [][]string
	fields []string
	issues map[string]map[string]any
	err    error
}

func (s *stubTracker) Search(context.Context, string, string, int) (tracker.Page, error) {
	return tracker.Page{}, errors.New("not implemented")
}
func (s *stubTracker) GetIssue(context.Context, string) (tracker.Issue, error) {
	return tracker.Issue{}, errors.New("not implemented")
}
func (s *stubTracker) BaseURL() string { return "https://jira.test" }

func (s *stubTracker) FetchIssues(_ context.Context, keys, extraFields []string) ([]tracker.FetchedIssue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	s.keys = append(s.keys, keys)
	s.fields = extraFields
	if s.err != nil {
		return nil, s.err
	}
	var out []tracker.FetchedIssue
	for _, key := range keys {
		fields, ok := s.issues[strings.ToUpper(key)]
		if !ok {
			continue
		}
		out = append(out, tracker.FetchedIssue{
			Issue: tracker.Issue{ID: key, Key: strings.ToUpper(key), Title: key,
				URL: "https://jira.test/browse/" + strings.ToUpper(key)},
			Raw: map[string]any{"key": strings.ToUpper(key), "fields": fields},
		})
	}
	return out, nil
}

func (s *stubTracker) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

const dueDateScript = "JIRA_FIELDS = [\"duedate\"]\n\n" +
	"def get_issue_time_range(issue):\n" +
	"    due = issue[\"fields\"].get(\"duedate\")\n" +
	"    return {\"end\": due, \"label\": \"Due date\"} if due else None\n"

func script(src string) ScriptFunc {
	return func(context.Context, int64) (string, error) { return src, nil }
}

// drain runs the fetcher until its queue empties, then stops it. Tests want the
// loop's behaviour without racing it.
func drain(t *testing.T, f *Fetcher) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { f.Run(ctx); close(done) }()
	deadline := time.After(5 * time.Second)
	for f.Pending(0) >= 0 {
		f.mu.Lock()
		empty := len(f.queue) == 0
		f.mu.Unlock()
		if empty {
			break
		}
		select {
		case <-deadline:
			t.Fatal("fetcher did not drain")
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	<-done
}

func statusOf(t *testing.T, f *Fetcher, keys ...string) map[string]Result {
	t.Helper()
	status, err := f.Status(context.Background(), 1, keys)
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]Result{}
	for _, r := range status.Results {
		byKey[r.Key] = r
	}
	return byKey
}

func TestFetcherChecksEnqueuedKeys(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{
		"PAY-1": {"duedate": "2026-04-12"},
		"PAY-2": {},
	}}
	f := New(stub, script(dueDateScript), 0)

	if n := f.Enqueue(1, []string{"PAY-1", "PAY-2", "GONE-9"}); n != 3 {
		t.Fatalf("queued %d", n)
	}
	drain(t, f)

	got := statusOf(t, f, "PAY-1", "PAY-2", "GONE-9")
	if r := got["PAY-1"]; r.State != StateOK || r.End != "2026-04-12" || r.Label != "Due date" {
		t.Fatalf("PAY-1 = %+v", r)
	}
	if r := got["PAY-1"]; r.Issue == nil || r.Issue.URL != "https://jira.test/browse/PAY-1" {
		t.Fatalf("PAY-1 issue = %+v", r.Issue)
	}
	// No date to compare is one state, however it came about.
	if r := got["PAY-2"]; r.State != StateSkipped {
		t.Fatalf("PAY-2 = %+v", r)
	}
	if r := got["GONE-9"]; r.State != StateNotFound || r.Issue != nil {
		t.Fatalf("GONE-9 = %+v", r)
	}
	// The script's fields reached the tracker.
	if len(stub.fields) != 1 || stub.fields[0] != "duedate" {
		t.Fatalf("fields = %v", stub.fields)
	}
}

// The central property: a poll is a pure read. However often a client asks,
// nothing reaches the tracker.
func TestStatusNeverFetches(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{}}
	f := New(stub, script(dueDateScript), 0)

	for range 25 {
		status, err := f.Status(context.Background(), 1, []string{"PAY-1", "PAY-2"})
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range status.Results {
			if r.State != StateUnchecked {
				t.Fatalf("state = %q, want unchecked before anything is enqueued", r.State)
			}
		}
	}
	if stub.callCount() != 0 {
		t.Fatalf("polling caused %d tracker calls", stub.callCount())
	}
	// And nothing was queued as a side effect of asking.
	if f.Pending(1) != 0 {
		t.Fatalf("polling queued %d keys", f.Pending(1))
	}
}

// Unchecked is a statement about Roadie, not about the issue: it is what a poll
// says while the work is still queued.
func TestStatusReportsQueuedKeysAsUnchecked(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{"PAY-1": {"duedate": "2026-04-12"}}}
	f := New(stub, script(dueDateScript), 0)
	f.Enqueue(1, []string{"PAY-1"})

	status, err := f.Status(context.Background(), 1, []string{"PAY-1"})
	if err != nil {
		t.Fatal(err)
	}
	if status.Results[0].State != StateUnchecked || status.Pending != 1 {
		t.Fatalf("before the run: %+v pending=%d", status.Results[0], status.Pending)
	}

	drain(t, f)

	status, err = f.Status(context.Background(), 1, []string{"PAY-1"})
	if err != nil {
		t.Fatal(err)
	}
	if status.Results[0].State != StateOK || status.Pending != 0 {
		t.Fatalf("after the run: %+v pending=%d", status.Results[0], status.Pending)
	}
}

// Re-enqueueing what is already established costs the tracker nothing, which is
// what makes leaning on Refresh harmless.
func TestFetcherSkipsFreshKeys(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{"PAY-1": {"duedate": "2026-04-12"}}}
	f := New(stub, script(dueDateScript), 0)

	for range 3 {
		f.Enqueue(1, []string{"PAY-1"})
		drain(t, f)
	}
	if stub.callCount() != 1 {
		t.Fatalf("tracker called %d times for three runs of the same key", stub.callCount())
	}
}

// Freshness is a debounce, not a correctness window.
func TestFetcherRefetchesOnceStale(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{"PAY-1": {"duedate": "2026-04-12"}}}
	f := New(stub, script(dueDateScript), time.Minute)
	now := time.Now()
	f.cache.now = func() time.Time { return now }

	f.Enqueue(1, []string{"PAY-1"})
	drain(t, f)
	now = now.Add(30 * time.Second)
	f.Enqueue(1, []string{"PAY-1"})
	drain(t, f)
	if stub.callCount() != 1 {
		t.Fatalf("refetched inside the window: %d calls", stub.callCount())
	}
	now = now.Add(time.Minute)
	f.Enqueue(1, []string{"PAY-1"})
	drain(t, f)
	if stub.callCount() != 2 {
		t.Fatalf("calls = %d, want a refetch once stale", stub.callCount())
	}
}

// Editing a script changes the fingerprint, so its answers are not served from
// what the previous one produced — and nothing has to remember to invalidate.
func TestScriptEditIsNotServedFromTheOldCache(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{
		"PAY-1": {"duedate": "2026-04-12", "customfield_1": "2026-09-30"},
	}}
	source := dueDateScript
	f := New(stub, func(context.Context, int64) (string, error) { return source, nil }, 0)

	f.Enqueue(1, []string{"PAY-1"})
	drain(t, f)
	if got := statusOf(t, f, "PAY-1")["PAY-1"]; got.End != "2026-04-12" {
		t.Fatalf("first script = %+v", got)
	}

	source = "JIRA_FIELDS = [\"customfield_1\"]\n\ndef get_issue_time_range(issue):\n" +
		"    return {\"end\": issue[\"fields\"][\"customfield_1\"]}\n"

	// The old answer is not reused; it reads as unchecked until refetched.
	if got := statusOf(t, f, "PAY-1")["PAY-1"]; got.State != StateUnchecked {
		t.Fatalf("the edited script was answered from the old one: %+v", got)
	}
	f.Enqueue(1, []string{"PAY-1"})
	drain(t, f)
	if got := statusOf(t, f, "PAY-1")["PAY-1"]; got.End != "2026-09-30" {
		t.Fatalf("after the edit = %+v", got)
	}
}

// A batch that cannot be fetched must still answer, or its keys poll as
// unchecked forever with nothing left to produce them. What it answers is the
// deployment's problem stated generically — see TestOperatorFailuresAreNotExposed.
func TestFetchFailureIsRecordedPerKey(t *testing.T) {
	stub := &stubTracker{err: errors.New("jira is down")}
	f := New(stub, script(dueDateScript), 0)
	f.Enqueue(1, []string{"PAY-1", "PAY-2"})
	drain(t, f)

	answered := statusOf(t, f, "PAY-1", "PAY-2")
	if len(answered) != 2 {
		t.Fatalf("results = %+v", answered)
	}
	for key, got := range answered {
		if got.State != StateError || got.Error == "" {
			t.Fatalf("%s = %+v", key, got)
		}
		if strings.Contains(got.Error, "jira is down") {
			t.Fatalf("%s leaked the upstream detail: %q", key, got.Error)
		}
	}
}

// A script that will not compile is the author's problem, and every key it was
// meant to check says so rather than hanging.
func TestCompileFailureIsRecordedPerKey(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{}}
	f := New(stub, script("def get_issue_time_range(issue)\n"), 0)
	f.Enqueue(1, []string{"PAY-1"})
	drain(t, f)

	if got := statusOf(t, f, "PAY-1")["PAY-1"]; got.State != StateError {
		t.Fatalf("PAY-1 = %+v", got)
	}
	if stub.callCount() != 0 {
		t.Fatalf("a script that does not compile still hit the tracker")
	}
}

// One raising issue is one error state; the others in the batch still resolve.
func TestScriptErrorIsPerIssue(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{
		"PAY-1": {"duedate": "2026-04-12"},
		"PAY-2": {"duedate": "not a date"},
	}}
	f := New(stub, script(dueDateScript), 0)
	f.Enqueue(1, []string{"PAY-1", "PAY-2"})
	drain(t, f)

	got := statusOf(t, f, "PAY-1", "PAY-2")
	if got["PAY-1"].State != StateOK || got["PAY-2"].State != StateError {
		t.Fatalf("results = %+v", got)
	}
}

// The queue is a set: asking twice for the same key does not fetch it twice.
func TestEnqueueDeduplicates(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{"PAY-1": {"duedate": "2026-04-12"}}}
	f := New(stub, script(dueDateScript), 0)
	f.Enqueue(1, []string{"PAY-1", "pay-1", "PAY-1"})
	if f.Pending(1) != 1 {
		t.Fatalf("pending = %d, want the repeats collapsed", f.Pending(1))
	}
}

// A backlog cannot grow without limit: one caller must not be able to spend the
// process's memory. Refused keys stay unchecked and can be asked for again.
func TestEnqueueIsBounded(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{}}
	f := New(stub, script(dueDateScript), 0)
	keys := make([]string, maxQueued+500)
	for i := range keys {
		keys[i] = fmt.Sprintf("PAY-%d", i+1)
	}
	if n := f.Enqueue(1, keys); n != maxQueued {
		t.Fatalf("accepted %d, want the queue bound of %d", n, maxQueued)
	}
	if f.Pending(1) != maxQueued {
		t.Fatalf("pending = %d", f.Pending(1))
	}
}

// One batch is one roadmap, so one script and one field set cover it.
func TestBatchesDoNotMixRoadmaps(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{
		"A-1": {"duedate": "2026-04-12"},
		"B-1": {"duedate": "2026-04-13"},
	}}
	f := New(stub, script(dueDateScript), 0)
	f.Enqueue(1, []string{"A-1"})
	f.Enqueue(2, []string{"B-1"})
	drain(t, f)

	if len(stub.keys) != 2 {
		t.Fatalf("batches = %v, want one per roadmap", stub.keys)
	}
	for _, batch := range stub.keys {
		if len(batch) != 1 {
			t.Fatalf("a batch mixed roadmaps: %v", stub.keys)
		}
	}
}

// Enqueue must be safe to call from many requests at once, and no key may be
// lost between a draining loop and an arriving one.
func TestConcurrentEnqueueLosesNothing(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{}}
	for i := range 200 {
		stub.issues[fmt.Sprintf("PAY-%d", i+1)] = map[string]any{"duedate": "2026-04-12"}
	}
	f := New(stub, script(dueDateScript), 0)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { f.Run(ctx); close(done) }()

	var wg sync.WaitGroup
	for i := range 200 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			f.Enqueue(1, []string{fmt.Sprintf("PAY-%d", i+1)})
		}()
	}
	wg.Wait()

	deadline := time.After(10 * time.Second)
	for {
		status, err := f.Status(context.Background(), 1, []string{"PAY-200"})
		if err != nil {
			t.Fatal(err)
		}
		if status.Pending == 0 && status.Results[0].State != StateUnchecked {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("keys stranded: pending=%d", status.Pending)
		case <-time.After(2 * time.Millisecond):
		}
	}
	cancel()
	<-done

	keys := make([]string, 200)
	for i := range keys {
		keys[i] = fmt.Sprintf("PAY-%d", i+1)
	}
	for key, got := range statusOf(t, f, keys...) {
		if got.State != StateOK {
			t.Fatalf("%s never got an answer: %+v", key, got)
		}
	}
}

// The cache holds extracted results, never the raw issue. JIRA_FIELDS is
// user-supplied and unbounded — a script naming `attachment` or `comment` pulls
// documents — so caching before extraction would turn a field list into server
// memory that a client chooses the size of.
func TestCacheHoldsNoRawIssuePayload(t *testing.T) {
	bulky := strings.Repeat("x", 8192)
	stub := &stubTracker{issues: map[string]map[string]any{
		"PAY-1": {"duedate": "2026-04-12", "attachment": bulky},
	}}
	f := New(stub, script(dueDateScript), 0)
	f.Enqueue(1, []string{"PAY-1"})
	drain(t, f)

	f.cache.mu.Lock()
	defer f.cache.mu.Unlock()
	if len(f.cache.entries) != 1 {
		t.Fatalf("entries = %d", len(f.cache.entries))
	}
	for _, e := range f.cache.entries {
		if strings.Contains(fmt.Sprint(e.result), bulky) {
			t.Fatal("the cache is holding raw issue payload")
		}
	}
}

// Entries lapse, so the map is bounded by recent traffic rather than by how
// many roadmaps or issues exist.
func TestCacheEvictsLapsedEntries(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{"PAY-1": {"duedate": "2026-04-12"}}}
	f := New(stub, script(dueDateScript), time.Minute)
	now := time.Now()
	f.cache.now = func() time.Time { return now }

	f.Enqueue(1, []string{"PAY-1"})
	drain(t, f)
	now = now.Add(2 * time.Minute)
	// Any lookup sweeps; a poll is enough.
	statusOf(t, f, "PAY-1")

	f.cache.mu.Lock()
	defer f.cache.mu.Unlock()
	if len(f.cache.entries) != 0 {
		t.Fatalf("entries = %d, want the lapsed one swept", len(f.cache.entries))
	}
}

// A roadmap with no script must not grow the cache. Results are keyed by the
// script's fingerprint, so without a script there is nothing a read could
// consult — and Status fails at the same lookup, so it never sweeps either.
func TestNoScriptDoesNotGrowTheCache(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{}}
	missing := func(context.Context, int64) (string, error) {
		return "", errors.New("no extractor for this roadmap")
	}
	f := New(stub, missing, 0)

	for round := range 20 {
		keys := make([]string, 50)
		for i := range keys {
			keys[i] = fmt.Sprintf("PAY-%d", round*50+i+1)
		}
		f.Enqueue(1, keys)
		drain(t, f)
	}

	f.cache.mu.Lock()
	defer f.cache.mu.Unlock()
	if len(f.cache.entries) != 0 {
		t.Fatalf("cache grew to %d entries for a roadmap with no script", len(f.cache.entries))
	}
}

// Lapsed entries go even on a path that only ever writes, so the bound does not
// depend on anybody reading.
func TestCacheSweepsOnWrite(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{}}
	f := New(stub, script("def get_issue_time_range(issue)\n"), time.Minute) // never compiles
	now := time.Now()
	f.cache.now = func() time.Time { return now }

	f.Enqueue(1, []string{"PAY-1"})
	drain(t, f)
	now = now.Add(2 * time.Minute)
	f.Enqueue(1, []string{"PAY-2"})
	drain(t, f)

	f.cache.mu.Lock()
	defer f.cache.mu.Unlock()
	if len(f.cache.entries) != 1 {
		t.Fatalf("entries = %d, want the lapsed one swept by the write", len(f.cache.entries))
	}
}

// A tracker failure the deployment owns must not put its response body in front
// of whoever is looking at a roadmap.
func TestOperatorFailuresAreNotExposed(t *testing.T) {
	body := "<html>nginx/1.24.0 upstream timed out: 10.0.0.7:8080</html>"
	stub := &stubTracker{err: fmt.Errorf("fetch Jira issues: Jira returned 502 Bad Gateway: %s", body)}
	f := New(stub, script(dueDateScript), 0)
	f.Enqueue(1, []string{"PAY-1"})
	drain(t, f)

	got := statusOf(t, f, "PAY-1")["PAY-1"]
	if got.State != StateError {
		t.Fatalf("PAY-1 = %+v", got)
	}
	if strings.Contains(got.Error, "nginx") || strings.Contains(got.Error, "10.0.0.7") {
		t.Fatalf("the response body reached the client: %q", got.Error)
	}
}

// A query the tracker itself rejected and explained is the user's to fix, so
// its wording still travels — the same rule the interactive search follows.
func TestQueryErrorsKeepTheirWording(t *testing.T) {
	const msg = "Field 'key' does not exist or you do not have permission to view it."
	stub := &stubTracker{err: &tracker.QueryError{Message: msg}}
	f := New(stub, script(dueDateScript), 0)
	f.Enqueue(1, []string{"PAY-1"})
	drain(t, f)

	if got := statusOf(t, f, "PAY-1")["PAY-1"]; got.Error != msg {
		t.Fatalf("error = %q, want the tracker's own wording", got.Error)
	}
}

// A script's own failure names a line to fix and stays verbatim.
func TestScriptErrorsKeepTheirWording(t *testing.T) {
	stub := &stubTracker{issues: map[string]map[string]any{}}
	f := New(stub, script("def get_issue_time_range(issue)\n"), 0)
	f.Enqueue(1, []string{"PAY-1"})
	drain(t, f)

	if got := statusOf(t, f, "PAY-1")["PAY-1"]; !strings.Contains(got.Error, "extractor.star") {
		t.Fatalf("error = %q, want the script's own compile message", got.Error)
	}
}
