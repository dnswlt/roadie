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

// Client is the read-only issue-tracker surface used by reconciliation.
type Client interface {
	Search(ctx context.Context, query, continuation string, pageSize int) (Page, error)
	GetIssue(ctx context.Context, externalID string) (Issue, error)
}
