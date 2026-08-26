// Package recon fetches and caches tracker issue ranges for schedule checks.
package recon

import (
	"time"

	"github.com/dnswlt/roadie/internal/tracker"
)

const (
	// StateOK means the extractor returned at least one date.
	StateOK = "ok"
	// StateSkipped means the extractor returned no dates for the issue.
	StateSkipped = "skipped"
	// StateNotFound means the tracker did not return the issue.
	StateNotFound = "notFound"
	// StateError means fetching or extracting the issue failed.
	StateError = "error"
	// StateUnchecked means no result is cached for the current script.
	StateUnchecked = "unchecked"
)

// Result is one issue key's answer. Start, End and Label are set only in
// StateOK; Error only in StateError.
type Result struct {
	Key   string         `json:"key"`
	State string         `json:"state"`
	Issue *tracker.Issue `json:"issue,omitempty"`
	Start string         `json:"start,omitempty"`
	End   string         `json:"end,omitempty"`
	Label string         `json:"label,omitempty"`
	Error string         `json:"error,omitempty"`
	// CheckedAt is when this result was stored. It is zero for unchecked keys.
	CheckedAt time.Time `json:"checkedAt,omitzero"`
}

// Status is what a poll returns: an answer for every key asked about, and how
// many of this roadmap's keys are still waiting on the fetcher.
type Status struct {
	Results []Result `json:"results"`
	Pending int      `json:"pending"`
}
