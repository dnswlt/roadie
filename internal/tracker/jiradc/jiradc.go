// Package jiradc implements tracker.Client using Jira Data Center REST API v2.
package jiradc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/dnswlt/roadie/internal/tracker"
)

const maxResponseBytes = 16 << 20

// Config describes one Jira Data Center deployment. Token is optional so the
// local development mock can run without authentication. In production it is
// sent as a bearer token on every request.
type Config struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// Client translates Jira's REST representation and offset paging into the
// deliberately smaller tracker.Client contract.
type Client struct {
	baseURL *url.URL
	token   string
	http    *http.Client
}

var _ tracker.Client = (*Client)(nil)

// New validates the deployment URL once, so request methods can safely append
// paths to Jira installations both at a host root and below a context path.
func New(cfg Config) (*Client, error) {
	base, err := url.Parse(strings.TrimSpace(cfg.BaseURL))
	if err != nil {
		return nil, fmt.Errorf("jira base URL: %w", err)
	}
	if (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return nil, fmt.Errorf("jira base URL must be an absolute HTTP(S) URL")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, fmt.Errorf("jira base URL must not contain credentials, a query, or a fragment")
	}
	base.Path = strings.TrimRight(base.Path, "/")

	httpClient := cfg.Client
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &Client{baseURL: base, token: strings.TrimSpace(cfg.Token), http: httpClient}, nil
}

type searchRequest struct {
	JQL        string   `json:"jql"`
	StartAt    int      `json:"startAt"`
	MaxResults int      `json:"maxResults"`
	Fields     []string `json:"fields"`
}

type jiraPage struct {
	StartAt    int `json:"startAt"`
	MaxResults int `json:"maxResults"`
	// Atlassian documents total as optional and liable to change between pages.
	Total  *int        `json:"total"`
	Issues []jiraIssue `json:"issues"`
}

type jiraIssue struct {
	ID     string `json:"id"`
	Key    string `json:"key"`
	Fields struct {
		Summary   string `json:"summary"`
		IssueType struct {
			Name string `json:"name"`
		} `json:"issuetype"`
		Status struct {
			Name string `json:"name"`
		} `json:"status"`
	} `json:"fields"`
}

// Search passes JQL through unchanged and asks Jira only for fields Recon
// displays. continuation is opaque to callers; this adapter represents it as
// Jira's next startAt offset.
func (c *Client) Search(ctx context.Context, query, continuation string, pageSize int) (tracker.Page, error) {
	if pageSize <= 0 {
		return tracker.Page{}, fmt.Errorf("jira search page size must be positive")
	}
	startAt, err := decodeContinuation(continuation)
	if err != nil {
		return tracker.Page{}, err
	}
	body, err := json.Marshal(searchRequest{
		JQL:        query,
		StartAt:    startAt,
		MaxResults: pageSize,
		Fields:     []string{"summary", "issuetype", "status"},
	})
	if err != nil {
		return tracker.Page{}, fmt.Errorf("encode Jira search: %w", err)
	}

	var result jiraPage
	if err := c.do(ctx, http.MethodPost, c.endpoint("rest", "api", "2", "search").String(), bytes.NewReader(body), &result); err != nil {
		return tracker.Page{}, searchError(err)
	}

	page := tracker.Page{Issues: make([]tracker.Issue, len(result.Issues))}
	for i, issue := range result.Issues {
		page.Issues[i] = c.normalize(issue)
	}
	// An empty page must end iteration even if a stale total claims that more
	// exists; returning the same offset would make Load more loop forever.
	nextAt := result.StartAt + len(result.Issues)
	more := len(result.Issues) > 0
	if more {
		if result.Total != nil {
			more = nextAt < *result.Total
		} else if result.MaxResults > 0 {
			more = len(result.Issues) >= result.MaxResults
		}
	}
	if more {
		page.Next = strconv.Itoa(nextAt)
	}
	return page, nil
}

// GetIssue resolves either Jira's numeric issue ID or its human-readable key.
func (c *Client) GetIssue(ctx context.Context, externalID string) (tracker.Issue, error) {
	externalID = strings.TrimSpace(externalID)
	if externalID == "" {
		return tracker.Issue{}, fmt.Errorf("jira issue ID is required")
	}
	if strings.ContainsAny(externalID, "/?#") {
		return tracker.Issue{}, fmt.Errorf("invalid Jira issue ID")
	}
	u := c.endpoint("rest", "api", "2", "issue", externalID)
	q := u.Query()
	q.Set("fields", "summary,issuetype,status")
	u.RawQuery = q.Encode()
	var issue jiraIssue
	if err := c.do(ctx, http.MethodGet, u.String(), nil, &issue); err != nil {
		var responseErr *responseError
		if errors.As(err, &responseErr) && responseErr.statusCode == http.StatusNotFound {
			return tracker.Issue{}, fmt.Errorf("%w: %s", tracker.ErrNotFound, externalID)
		}
		return tracker.Issue{}, fmt.Errorf("get Jira issue %q: %w", externalID, err)
	}
	return c.normalize(issue), nil
}

func decodeContinuation(raw string) (int, error) {
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("invalid Jira continuation")
	}
	return n, nil
}

// normalize is the only place Jira's field nesting crosses into the generic
// model. The browser URL is constructed because Jira's self link targets REST.
func (c *Client) normalize(issue jiraIssue) tracker.Issue {
	return tracker.Issue{
		ID:     issue.ID,
		Key:    issue.Key,
		Title:  issue.Fields.Summary,
		Type:   issue.Fields.IssueType.Name,
		Status: issue.Fields.Status.Name,
		URL:    c.endpoint("browse", issue.Key).String(),
	}
}

// searchError promotes a rejection Jira explained into tracker.QueryError, so
// the server can pass Jira's own wording to the user — a JQL syntax error is
// only actionable in Jira's words.
//
// Exactly 400, not 4xx. The request body a user controls is the query, so only
// "your request was malformed" can be attributed to them. 401/403 means the
// deployment's token is wrong or unprivileged and 404 that the base URL is:
// operator faults that must stay a logged 502, because blaming them on
// whoever typed the query sends every user hunting a JQL bug that isn't there.
func searchError(err error) error {
	var resp *responseError
	if errors.As(err, &resp) && resp.statusCode == http.StatusBadRequest {
		if msg := resp.userMessage(); msg != "" {
			return &tracker.QueryError{Message: msg}
		}
	}
	return fmt.Errorf("search Jira: %w", err)
}

type responseError struct {
	statusCode int
	status     string
	// The raw bounded response body. Kept verbatim for the log; userMessage
	// derives the part fit to show a user.
	detail string
}

func (e *responseError) Error() string {
	if e.detail != "" {
		return fmt.Sprintf("Jira returned %s: %s", e.status, e.detail)
	}
	return fmt.Sprintf("Jira returned %s", e.status)
}

// userMessage unwraps Jira's error envelope — {"errorMessages": [...],
// "errors": {field: msg}} — into one line. Anything else (an HTML error page
// from a proxy, an empty body) yields "", so only text Jira composed as an
// explanation can reach a user. Field errors are sorted so one rejection
// always reads the same way.
func (e *responseError) userMessage() string {
	var env struct {
		ErrorMessages []string          `json:"errorMessages"`
		Errors        map[string]string `json:"errors"`
	}
	if json.Unmarshal([]byte(e.detail), &env) != nil {
		return ""
	}
	parts := slices.Clone(env.ErrorMessages)
	for _, field := range slices.Sorted(maps.Keys(env.Errors)) {
		parts = append(parts, fmt.Sprintf("%s: %s", field, env.Errors[field]))
	}
	return strings.TrimSpace(strings.Join(parts, "; "))
}

// do owns the shared wire policy: JSON headers, bearer authentication, bounded
// error text and response decoding. It intentionally does not interpret HTTP
// statuses; an issue lookup's 404 and a missing search endpoint mean different
// things to callers.
func (c *Client) do(ctx context.Context, method, endpoint string, body io.Reader, dst any) error {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &responseError{
			statusCode: resp.StatusCode,
			status:     resp.Status,
			detail:     strings.TrimSpace(string(message)),
		}
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(dst); err != nil {
		return fmt.Errorf("decode Jira response: %w", err)
	}
	return nil
}

// endpoint preserves a configured Jira context path such as /jira.
func (c *Client) endpoint(parts ...string) *url.URL {
	return c.baseURL.JoinPath(parts...)
}
