// Package tracker defines the external issue-tracker capability used by
// reconciliation. Provider-specific query languages, paging and response
// shapes stay behind Client implementations.
package tracker

import (
	"context"
	"errors"
)

// ErrNotFound means an external issue does not exist or is not visible to the
// configured tracker identity.
var ErrNotFound = errors.New("tracker issue not found")

// QueryError is a request the tracker itself rejected and explained — an
// invalid query being the usual case. Message is the provider's own wording,
// the only text that can say which part of a query was wrong, so it is meant
// to reach the user and not just the log. Adapters must only wrap provider
// text they can attribute to the request; see jiradc.searchError.
type QueryError struct {
	Message string
}

func (e *QueryError) Error() string { return e.Message }

// Issue is the small provider-neutral projection reconciliation needs.
type Issue struct {
	ID     string `json:"id"`
	Key    string `json:"key"`
	Title  string `json:"title"`
	Type   string `json:"type"`
	Status string `json:"status"`
	URL    string `json:"url"`
}

// Page is one explicitly requested batch. Next is opaque to callers and empty
// when the provider has no more results.
type Page struct {
	Issues []Issue `json:"issues"`
	Next   string  `json:"next,omitempty"`
}

// FetchedIssue pairs the neutral projection with provider-shaped JSON for the
// extractor. Raw is never serialized.
type FetchedIssue struct {
	Issue Issue
	Raw   map[string]any
}

// Client is the read-only issue-tracker surface used by reconciliation.
type Client interface {
	Search(ctx context.Context, query, continuation string, pageSize int) (Page, error)
	GetIssue(ctx context.Context, externalID string) (Issue, error)
	// FetchIssues resolves keys with the fields required by Issue plus
	// extraFields. Unusable keys are absent from the result. Recovery from
	// unusable keys must use a fixed request bound.
	FetchIssues(ctx context.Context, keys, extraFields []string) ([]FetchedIssue, error)
	// BaseURL is the deployment as a browser reaches it, without a trailing
	// slash — the same authority Issue.URL is built from. Reconciliation needs
	// it to decide which links in an item description belong to this tracker at
	// all, which is not answerable from an issue's own URL when there is no
	// issue in hand.
	BaseURL() string
}
