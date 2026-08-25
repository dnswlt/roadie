package recon

import (
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/dnswlt/roadie/internal/tracker"
	"github.com/dnswlt/roadie/internal/tracker/extractor"
)

const (
	// keysPerRun is how many keys one turn of the loop takes on. The adapter
	// batches internally; this bounds how long the single fetcher spends on one
	// roadmap before it looks at what else is waiting.
	keysPerRun = 100
	// maxQueued bounds the backlog. Reached, further keys are refused rather
	// than queued: they read as unchecked, the client sees fewer answers than
	// it asked for, and re-enqueues. Growing without limit instead would let
	// one caller spend the process's memory.
	maxQueued = 10_000
)

// ScriptFunc returns a roadmap's extractor source. The fetcher calls it when it
// reaches a roadmap's keys rather than when they were enqueued, so a script
// edited mid-queue takes effect on what has not run yet.
type ScriptFunc func(ctx context.Context, roadmapID int64) (string, error)

// Fetcher owns every request Roadie makes to the tracker for schedule checks.
// There is exactly one, working through its queue a batch at a time, and that
// is the whole rate-limiting story: nothing runs concurrently, so there is no
// bucket or budget to tune.
//
// A poll is a pure read of the cache. It must never be able to start a fetch,
// hurry one, or reorder the queue.
type Fetcher struct {
	tracker tracker.Client
	script  ScriptFunc
	cache   *Cache

	mu    sync.Mutex
	queue []queued
	seen  map[queued]bool
	// wake carries one token: a nudge that the queue is non-empty. Buffered so
	// Enqueue never blocks and never needs the loop to be listening yet.
	wake chan struct{}
}

type queued struct {
	roadmapID int64
	key       string
}

func New(t tracker.Client, script ScriptFunc, freshness time.Duration) *Fetcher {
	if freshness == 0 {
		freshness = DefaultFreshness
	}
	return &Fetcher{
		tracker: t,
		script:  script,
		cache:   newCache(freshness),
		seen:    map[queued]bool{},
		wake:    make(chan struct{}, 1),
	}
}

// Enqueue asks for these keys to be checked under this roadmap's script and
// returns how many were accepted, without waiting for them; the caller polls
// Status. Keys already queued are not queued twice.
//
// Fresh keys are accepted and skipped later, at run time: a key can go stale
// while it waits, so only the fetcher is in a position to judge.
func (f *Fetcher) Enqueue(roadmapID int64, keys []string) int {
	f.mu.Lock()
	accepted := 0
	for _, key := range keys {
		if key = strings.TrimSpace(key); key == "" {
			continue
		}
		q := queued{roadmapID: roadmapID, key: strings.ToUpper(key)}
		if f.seen[q] || len(f.queue) >= maxQueued {
			continue
		}
		f.seen[q] = true
		f.queue = append(f.queue, q)
		accepted++
	}
	f.mu.Unlock()

	if accepted > 0 {
		select {
		case f.wake <- struct{}{}:
		default: // a nudge is already pending; one is enough
		}
	}
	return accepted
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

// Pending reports how many of a roadmap's keys are still waiting. Read-only:
// see Status.
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

// run checks one batch and records what it learns. Every path writes a result
// for every key it took: a key that vanished from the queue without an answer
// would poll as unchecked forever, with nothing left to produce it.
func (f *Fetcher) run(ctx context.Context, roadmapID int64, batch []string) {
	source, err := f.script(ctx, roadmapID)
	if err != nil {
		// Nothing is recorded: an entry is keyed by the script's fingerprint,
		// and Status fails at this same lookup, so anything written here could
		// only accumulate unread. The keys stay unchecked until asked for
		// again, and the poll reports the missing script instead.
		log.Printf("recon: no script for roadmap %d, dropping %d keys: %v", roadmapID, len(batch), err)
		return
	}
	fingerprint := newScriptFingerprint(source)
	script, err := extractor.Compile(source)
	if err != nil {
		// The script author's own error, verbatim: it names a line to fix.
		f.record(fingerprint, batch, err.Error())
		return
	}

	// Skip what is already established and still fresh. Checked here rather
	// than at enqueue so a key that went stale in the queue is refetched.
	_, stale := f.cache.lookup(fingerprint, batch)
	if len(stale) == 0 {
		return
	}

	issues, err := f.tracker.FetchIssues(ctx, stale, script.Fields())
	if err != nil {
		f.record(fingerprint, stale, trackerMessage(roadmapID, len(stale), err))
		return
	}

	// The tracker canonicalizes a key's case, so results are paired back to
	// what was asked for rather than to what came back.
	byKey := make(map[string]tracker.FetchedIssue, len(issues))
	for _, issue := range issues {
		byKey[strings.ToUpper(issue.Issue.Key)] = issue
	}

	results := make([]Result, 0, len(stale))
	for _, key := range stale {
		issue, ok := byKey[strings.ToUpper(key)]
		if !ok {
			results = append(results, Result{Key: key, State: StateNotFound})
			continue
		}
		row := Result{Key: key, Issue: neutral(issue.Issue)}
		// Per issue: one raising script call is one error state, and every
		// other issue in the batch still gets its answer.
		res, err := script.TimeRange(issue.Raw)
		switch {
		case err != nil:
			row.State, row.Error = StateError, err.Error()
		case res.Skip:
			row.State = StateSkipped
		default:
			row.State, row.Start, row.End, row.Label = StateOK, res.Start, res.End, res.Label
		}
		results = append(results, row)
		// issue.Raw is dropped here and never stored: a script may name
		// `attachment` or `comment`, and those are documents.
	}
	f.cache.store(fingerprint, results)
}

// record answers a whole batch with one message, so a poll sees why rather than
// waiting for an answer that is never coming. Retrying is the caller's to do by
// enqueueing again, so a broken deployment is not hammered in a loop.
//
// The message reaches a browser: see trackerMessage for what may go in one.
func (f *Fetcher) record(fingerprint scriptFingerprint, keys []string, message string) {
	results := make([]Result, 0, len(keys))
	for _, key := range keys {
		results = append(results, Result{Key: key, State: StateError, Error: message})
	}
	f.cache.store(fingerprint, results)
}

// trackerMessage decides how much of a failure a user may see, on the same rule
// the interactive search uses: a query the tracker rejected and explained is
// the user's to fix, so its wording travels. Anything else is the deployment's
// problem, and its detail — kilobytes of Jira or proxy response text — stays in
// the log.
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
	known, _ := f.cache.lookup(fingerprint, keys)
	results := make([]Result, 0, len(keys))
	for _, key := range keys {
		if result, ok := known[strings.ToUpper(key)]; ok {
			results = append(results, result)
			continue
		}
		results = append(results, Result{Key: key, State: StateUnchecked})
	}
	return Status{Results: results, Pending: f.Pending(roadmapID)}, nil
}

func neutral(issue tracker.Issue) *Issue {
	return &Issue{
		ID: issue.ID, Key: issue.Key, Title: issue.Title,
		Type: issue.Type, Status: issue.Status, URL: issue.URL,
	}
}
