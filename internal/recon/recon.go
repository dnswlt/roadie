package recon

// The states one issue key can be in. They are exclusive, and Recon renders
// each differently: a skipped issue is not a warning, a missing one is not a
// script failure, and neither is a range that simply does not fit.
const (
	StateOK      = "ok"
	StateSkipped = "skipped"
	// StateNotFound means the tracker did not return the key: deleted, renamed,
	// or invisible to the configured identity.
	StateNotFound = "notFound"
	StateError    = "error"
	// StateUnchecked means nothing has been established yet — not fetched, or
	// fetched too long ago to still be fresh. It is the answer a poll gives
	// while the fetcher is still working, and it says nothing about the issue.
	StateUnchecked = "unchecked"
)

// Result is one issue key's answer. Start, End and Label are set only in
// StateOK; Error only in StateError.
//
// Whether the range *fits* is not decided here — that is Roadie's rule, applied
// against the item, which only the frontend holds.
type Result struct {
	Key   string `json:"key"`
	State string `json:"state"`
	// Issue is the tracker's own projection, absent when nothing resolved.
	Issue *Issue `json:"issue,omitempty"`
	Start string `json:"start,omitempty"`
	End   string `json:"end,omitempty"`
	Label string `json:"label,omitempty"`
	Error string `json:"error,omitempty"`
}

// Issue is the neutral projection Recon displays. It mirrors tracker.Issue
// rather than embedding it so that what crosses the wire is this package's
// decision, not a tracker refactor's.
type Issue struct {
	ID     string `json:"id"`
	Key    string `json:"key"`
	Title  string `json:"title"`
	Type   string `json:"type"`
	Status string `json:"status"`
	URL    string `json:"url"`
}

// Status is what a poll returns: an answer for every key asked about, and how
// many of this roadmap's keys are still waiting on the fetcher.
//
// Pending is read from the queue, never written to it: polling cannot start,
// hurry, or reorder a fetch.
type Status struct {
	Results []Result `json:"results"`
	Pending int      `json:"pending"`
}
