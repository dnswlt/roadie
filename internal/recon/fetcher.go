package recon

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/dnswlt/roadie/internal/tracker"
	"github.com/dnswlt/roadie/internal/tracker/extractor"
)

const (
	defaultFreshness = time.Minute
	// keysPerRun bounds how long one roadmap holds the worker.
	keysPerRun = 100
	// maxQueued bounds the process-wide backlog.
	maxQueued = 10_000
)

// ScriptFunc returns a roadmap's extractor source. The fetcher calls it when it
// reaches a roadmap's keys rather than when they were enqueued, so a script
// edited mid-queue takes effect on what has not run yet.
type ScriptFunc func(ctx context.Context, roadmapID int64) (string, error)

// Fetcher serializes schedule-check requests through one queue.
//
// A poll is a pure read of the cache. It must never be able to start a fetch,
// hurry one, or reorder the queue.
type Fetcher struct {
	tracker   tracker.Client
	script    ScriptFunc
	cache     *cache
	freshness time.Duration

	mu    sync.Mutex
	queue []queued
	seen  map[queued]bool
	// wake is a non-blocking notification that the queue is non-empty.
	wake chan struct{}
}

type queued struct {
	roadmapID int64
	key       string
}

func New(t tracker.Client, script ScriptFunc, freshness time.Duration) *Fetcher {
	if freshness <= 0 {
		freshness = defaultFreshness
	}
	return &Fetcher{
		tracker:   t,
		script:    script,
		cache:     newCache(),
		freshness: freshness,
		seen:      map[queued]bool{},
		wake:      make(chan struct{}, 1),
	}
}

// Enqueue asks for these keys to be checked under this roadmap's script and
// returns how many are covered by the queue. Keys already queued count as
// covered but are not added twice; only a full queue lowers the count.
//
// Freshness is checked when a batch runs because cached results can age in the
// queue.
func (f *Fetcher) Enqueue(roadmapID int64, keys []string) int {
	f.mu.Lock()
	covered := 0
	for _, key := range keys {
		q := queued{roadmapID: roadmapID, key: key}
		if f.seen[q] {
			covered++
			continue
		}
		if len(f.queue) >= maxQueued {
			continue
		}
		f.seen[q] = true
		f.queue = append(f.queue, q)
		covered++
	}
	f.mu.Unlock()

	if covered > 0 {
		select {
		case f.wake <- struct{}{}:
		default: // a nudge is already pending; one is enough
		}
	}
	return covered
}

// Run is the one goroutine. It returns when ctx is cancelled.
func (f *Fetcher) Run(ctx context.Context) {
	for {
		roadmapID, batch := f.take()
		if len(batch) == 0 {
			select {
			case <-ctx.Done():
				return
			case <-f.wake:
			}
			continue
		}
		f.run(ctx, roadmapID, batch)
		if ctx.Err() != nil {
			return
		}
	}
}

// take pops the next batch, all from one roadmap so that one script and one
// field set cover it. FIFO by roadmap arrival, so a large roadmap cannot starve
// one queued behind it for longer than a batch.
func (f *Fetcher) take() (int64, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.queue) == 0 {
		return 0, nil
	}
	roadmapID := f.queue[0].roadmapID
	batch := make([]string, 0, keysPerRun)
	kept := f.queue[:0]
	for _, q := range f.queue {
		if q.roadmapID == roadmapID && len(batch) < keysPerRun {
			batch = append(batch, q.key)
			delete(f.seen, q)
			continue
		}
		kept = append(kept, q)
	}
	f.queue = kept
	return roadmapID, batch
}

// Pending reports how many of a roadmap's keys are still waiting.
func (f *Fetcher) Pending(roadmapID int64) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, q := range f.queue {
		if q.roadmapID == roadmapID {
			n++
		}
	}
	return n
}

func (f *Fetcher) run(ctx context.Context, roadmapID int64, batch []string) {
	source, err := f.script(ctx, roadmapID)
	if err != nil {
		log.Printf("recon: no script for roadmap %d, dropping %d keys: %v", roadmapID, len(batch), err)
		return
	}
	fingerprint := newScriptFingerprint(source)
	cached := f.cache.lookup(fingerprint, batch)
	now := f.cache.clock()
	due := make([]string, 0, len(batch))
	for _, key := range batch {
		result, ok := cached[key]
		if !ok || now.Sub(result.CheckedAt) >= f.freshness {
			due = append(due, key)
		}
	}
	if len(due) == 0 {
		return
	}
	script, err := extractor.Compile(source)
	if err != nil {
		f.record(fingerprint, due, err.Error())
		return
	}

	issues, err := f.tracker.FetchIssues(ctx, due, script.Fields())
	if err != nil {
		f.record(fingerprint, due, trackerMessage(roadmapID, len(due), err))
		return
	}

	// Results are paired by key because the tracker may return them in a
	// different order.
	byKey := make(map[string]tracker.FetchedIssue, len(issues))
	for _, issue := range issues {
		byKey[issue.Issue.Key] = issue
	}

	results := make([]Result, 0, len(due))
	for _, key := range due {
		issue, ok := byKey[key]
		if !ok {
			results = append(results, Result{Key: key, State: StateNotFound})
			continue
		}
		row := Result{Key: key, Issue: &issue.Issue}
		res, err := script.TimeRange(issue.Raw)
		switch {
		case err != nil:
			row.State, row.Error = StateError, err.Error()
		case res.Skip:
			row.State = StateSkipped
		default:
			row.State = StateOK
			row.Start, row.End = res.Start, res.End
			row.StartPeriod, row.EndPeriod = res.StartPeriod, res.EndPeriod
			row.Label = res.Label
		}
		results = append(results, row)
	}
	f.cache.store(fingerprint, results)
}

// record stores the same error result for every key in a batch.
func (f *Fetcher) record(fingerprint scriptFingerprint, keys []string, message string) {
	results := make([]Result, 0, len(keys))
	for _, key := range keys {
		results = append(results, Result{Key: key, State: StateError, Error: message})
	}
	f.cache.store(fingerprint, results)
}

// trackerMessage exposes query errors and logs deployment failures.
func trackerMessage(roadmapID int64, keys int, err error) string {
	var qErr *tracker.QueryError
	if errors.As(err, &qErr) {
		return qErr.Message
	}
	log.Printf("recon: fetching %d issues for roadmap %d: %v", keys, roadmapID, err)
	return "issue tracker query failed"
}

// Status answers for exactly the keys asked about. Keys with nothing
// established read as StateUnchecked, whether they are queued, still being
// fetched, or were never asked for at all.
//
// This never touches the queue except to count it: polling has no influence on
// the fetcher.
func (f *Fetcher) Status(ctx context.Context, roadmapID int64, keys []string) (Status, error) {
	source, err := f.script(ctx, roadmapID)
	if err != nil {
		return Status{}, err
	}
	fingerprint := newScriptFingerprint(source)

	// An edited script has a different fingerprint, so answers produced by the
	// previous one are not found and read as unchecked, which is what they are.
	known := f.cache.lookup(fingerprint, keys)
	results := make([]Result, 0, len(keys))
	for _, key := range keys {
		if result, ok := known[key]; ok {
			results = append(results, result)
			continue
		}
		results = append(results, Result{Key: key, State: StateUnchecked})
	}
	return Status{Results: results, Pending: f.Pending(roadmapID)}, nil
}
