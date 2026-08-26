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
	"math"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/clientcredentials"

	"github.com/dnswlt/roadie/internal/tracker"
)

const maxResponseBytes = 16 << 20

// Config describes one Jira Data Center deployment. OAuth takes precedence
// over Token when both are configured.
type Config struct {
	// BaseURL is the deployment's browser-facing URL.
	BaseURL string
	// RestURL is where the REST API answers, for deployments that publish it on
	// a different host from the web UI. Empty means BaseURL serves both.
	RestURL string
	Token   string
	OAuth   OAuthConfig
	Client  *http.Client
}

// OAuthConfig configures an OAuth 2.0 client-credentials grant. TokenURL
// enables it.
type OAuthConfig struct {
	ClientID     string
	ClientSecret string
	TokenURL     string
	Scopes       []string
}

// Client implements tracker.Client for Jira Data Center.
type Client struct {
	webURL  *url.URL
	restURL *url.URL
	token   string
	tokens  oauth2.TokenSource
	http    *http.Client
	wait    func(context.Context, time.Duration) error
}

var _ tracker.Client = (*Client)(nil)

// New validates the deployment configuration.
func New(cfg Config) (*Client, error) {
	web, err := parseBaseURL(cfg.BaseURL, "base")
	if err != nil {
		return nil, err
	}
	rest := web
	if strings.TrimSpace(cfg.RestURL) != "" {
		if rest, err = parseBaseURL(cfg.RestURL, "REST base"); err != nil {
			return nil, err
		}
	}

	httpClient := cfg.Client
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	c := &Client{
		webURL:  web,
		restURL: rest,
		token:   strings.TrimSpace(cfg.Token),
		http:    httpClient,
		wait:    waitFor,
	}
	if cfg.OAuth.enabled() {
		tokens, err := cfg.OAuth.tokenSource(httpClient)
		if err != nil {
			return nil, err
		}
		c.token, c.tokens = "", tokens
	}
	return c, nil
}

func parseBaseURL(raw, what string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("jira %s URL: %w", what, err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("jira %s URL must be an absolute HTTP(S) URL", what)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("jira %s URL must not contain credentials, a query, or a fragment", what)
	}
	u.Path = strings.TrimRight(u.Path, "/")
	return u, nil
}

func (o OAuthConfig) enabled() bool { return strings.TrimSpace(o.TokenURL) != "" }

func (o OAuthConfig) tokenSource(httpClient *http.Client) (oauth2.TokenSource, error) {
	tokenURL := strings.TrimSpace(o.TokenURL)
	u, err := url.Parse(tokenURL)
	if err != nil {
		return nil, fmt.Errorf("jira OAuth token URL: %w", err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("jira OAuth token URL must be an absolute HTTP(S) URL")
	}
	clientID, clientSecret := strings.TrimSpace(o.ClientID), strings.TrimSpace(o.ClientSecret)
	if clientID == "" || clientSecret == "" {
		return nil, fmt.Errorf("jira OAuth needs a client ID and a client secret alongside the token URL")
	}
	cfg := &clientcredentials.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		TokenURL:     tokenURL,
		Scopes:       o.Scopes,
	}
	ctx := context.WithValue(context.Background(), oauth2.HTTPClient, httpClient)
	return cfg.TokenSource(ctx), nil
}

// displayFields are required to build tracker.Issue.
var displayFields = []string{"summary", "issuetype", "status"}

type searchRequest struct {
	JQL        string   `json:"jql"`
	StartAt    int      `json:"startAt"`
	MaxResults int      `json:"maxResults"`
	Fields     []string `json:"fields"`
}

type jiraPage struct {
	StartAt    int         `json:"startAt"`
	MaxResults int         `json:"maxResults"`
	Total      *int        `json:"total"`
	Issues     []jiraIssue `json:"issues"`
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

// Search passes JQL through unchanged and uses startAt as its continuation.
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
		Fields:     displayFields,
	})
	if err != nil {
		return tracker.Page{}, fmt.Errorf("encode Jira search: %w", err)
	}

	var result jiraPage
	if err := c.do(ctx, http.MethodPost, c.restEndpoint("rest", "api", "2", "search").String(), body, &result); err != nil {
		return tracker.Page{}, searchError(err)
	}

	page := tracker.Page{Issues: make([]tracker.Issue, len(result.Issues))}
	for i, issue := range result.Issues {
		page.Issues[i] = c.normalize(issue)
	}
	// An empty page ends iteration even when total is stale.
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
	u := c.restEndpoint("rest", "api", "2", "issue", externalID)
	q := u.Query()
	q.Set("fields", strings.Join(displayFields, ","))
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

// keysPerBatch stays within Jira's common search page limit.
const keysPerBatch = 100

// maxSalvageRounds bounds recovery when a rejection names only some bad keys.
const maxSalvageRounds = 3

// jiraKey prevents issue keys from changing the generated JQL.
var jiraKey = regexp.MustCompile(`^[A-Z][A-Z0-9_]*-[1-9][0-9]*$`)

// namedKey extracts quoted issue keys from Jira rejection messages.
var namedKey = regexp.MustCompile(`['"]([A-Z][A-Z0-9_]*-[1-9][0-9]*)['"]`)

// FetchIssues resolves keys in batches, asking for the display fields plus
// extraFields.
func (c *Client) FetchIssues(ctx context.Context, keys, extraFields []string) ([]tracker.FetchedIssue, error) {
	fields := slices.Clone(displayFields)
	for _, f := range extraFields {
		if f = strings.TrimSpace(f); f != "" && !slices.Contains(fields, f) {
			fields = append(fields, f)
		}
	}

	usable := make([]string, 0, len(keys))
	for _, key := range keys {
		if jiraKey.MatchString(key) {
			usable = append(usable, key)
		}
	}

	issues := []tracker.FetchedIssue{}
	remainingWait := maxRetryWait
	for batch := range slices.Chunk(usable, keysPerBatch) {
		got, err := c.fetchBatch(ctx, batch, fields, &remainingWait)
		if err != nil {
			return nil, err
		}
		issues = append(issues, got...)
	}
	return issues, nil
}

// fetchBatch retries a rejected JQL batch without the keys Jira named. It never
// drops a key that was not in the request.
func (c *Client) fetchBatch(ctx context.Context, batch, fields []string, remainingWait *time.Duration) ([]tracker.FetchedIssue, error) {
	sent := batch
	for range maxSalvageRounds {
		if len(sent) == 0 {
			return nil, nil
		}
		issues, err := c.withBackoff(ctx, remainingWait, func() ([]tracker.FetchedIssue, error) {
			return c.searchKeys(ctx, sent, fields)
		})
		if err == nil {
			return issues, nil
		}
		var resp *responseError
		if !errors.As(err, &resp) || resp.statusCode != http.StatusBadRequest {
			return nil, fmt.Errorf("fetch Jira issues: %w", err)
		}
		remaining := dropNamed(sent, resp.detail)
		if len(remaining) == len(sent) {
			return nil, searchError(err)
		}
		sent = remaining
	}
	return nil, fmt.Errorf("Jira kept rejecting a batch of %d issue keys after %d attempts", len(batch), maxSalvageRounds)
}

// dropNamed returns keys minus those named in a Jira rejection.
func dropNamed(keys []string, detail string) []string {
	named := map[string]bool{}
	for _, m := range namedKey.FindAllStringSubmatch(detail, -1) {
		named[m[1]] = true
	}
	if len(named) == 0 {
		return keys
	}
	kept := make([]string, 0, len(keys))
	for _, key := range keys {
		if !named[key] {
			kept = append(kept, key)
		}
	}
	return kept
}

const (
	maxAttempts    = 4
	maxRetryWait   = 30 * time.Second
	baseRetryDelay = 500 * time.Millisecond
)

// maxRetryAfterSeconds prevents duration overflow.
const maxRetryAfterSeconds = int64(math.MaxInt64) / int64(time.Second)

func retryable(err error) (*responseError, bool) {
	var resp *responseError
	if !errors.As(err, &resp) {
		return nil, false
	}
	return resp, resp.statusCode == http.StatusTooManyRequests || resp.statusCode == http.StatusServiceUnavailable
}

// retryAfterHeader parses delta-seconds and HTTP-date forms.
func retryAfterHeader(raw string, now time.Time) (time.Duration, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, false
	}
	if secs, err := strconv.ParseInt(raw, 10, 64); err == nil {
		if secs < 0 {
			return 0, false
		}
		if secs > maxRetryAfterSeconds {
			return time.Duration(math.MaxInt64), true
		}
		return time.Duration(secs) * time.Second, true
	}
	when, err := http.ParseTime(raw)
	if err != nil {
		return 0, false
	}
	return max(when.Sub(now), 0), true
}

// withBackoff retries one by-key search within the call's remaining wait budget.
func (c *Client) withBackoff(ctx context.Context, remainingWait *time.Duration, run func() ([]tracker.FetchedIssue, error)) ([]tracker.FetchedIssue, error) {
	var lastErr error
	for attempt := range maxAttempts {
		issues, err := run()
		resp, wantsRetry := retryable(err)
		if !wantsRetry {
			return issues, err
		}
		lastErr = err
		if attempt == maxAttempts-1 {
			break
		}
		delay, ok := retryAfterHeader(resp.retryAfter, time.Now())
		if !ok {
			delay = baseRetryDelay << attempt
		}
		if delay > *remainingWait {
			return nil, fmt.Errorf("Jira retry wait exceeds the %s budget: %w", maxRetryWait, err)
		}
		*remainingWait -= delay
		if err := c.wait(ctx, delay); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("Jira kept rate limiting after %d attempts: %w", maxAttempts, lastErr)
}

func waitFor(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// searchKeys performs one `key in (...)` request.
func (c *Client) searchKeys(ctx context.Context, keys, fields []string) ([]tracker.FetchedIssue, error) {
	quoted := make([]string, len(keys))
	for i, key := range keys {
		quoted[i] = `"` + key + `"`
	}
	body, err := json.Marshal(searchRequest{
		JQL:        "key in (" + strings.Join(quoted, ", ") + ")",
		MaxResults: len(keys),
		Fields:     fields,
	})
	if err != nil {
		return nil, fmt.Errorf("encode Jira fetch: %w", err)
	}
	var result struct {
		Issues []map[string]any `json:"issues"`
	}
	if err := c.do(ctx, http.MethodPost, c.restEndpoint("rest", "api", "2", "search").String(), body, &result); err != nil {
		return nil, err
	}
	// Unknown keys produce 400, so a successful short page is truncation.
	if len(result.Issues) != len(keys) {
		return nil, fmt.Errorf("Jira returned %d issues for %d keys; the deployment's search page cap (jira.search.views.default.max) is below %d",
			len(result.Issues), len(keys), len(keys))
	}
	issues := make([]tracker.FetchedIssue, len(result.Issues))
	for i, issue := range result.Issues {
		issues[i] = c.normalizeFetched(issue)
	}
	return issues, nil
}

// normalizeFetched derives tracker.Issue from the raw extractor input.
func (c *Client) normalizeFetched(raw map[string]any) tracker.FetchedIssue {
	fields := rawObject(raw, "fields")
	key := rawString(raw, "key")
	return tracker.FetchedIssue{
		Issue: tracker.Issue{
			ID:     rawString(raw, "id"),
			Key:    key,
			Title:  rawString(fields, "summary"),
			Type:   rawString(rawObject(fields, "issuetype"), "name"),
			Status: rawString(rawObject(fields, "status"), "name"),
			URL:    c.browseURL(key),
		},
		Raw: raw,
	}
}

func rawString(m map[string]any, name string) string {
	s, _ := m[name].(string)
	return s
}

func rawObject(m map[string]any, name string) map[string]any {
	nested, _ := m[name].(map[string]any)
	return nested
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

func (c *Client) normalize(issue jiraIssue) tracker.Issue {
	return tracker.Issue{
		ID:     issue.ID,
		Key:    issue.Key,
		Title:  issue.Fields.Summary,
		Type:   issue.Fields.IssueType.Name,
		Status: issue.Fields.Status.Name,
		URL:    c.browseURL(issue.Key),
	}
}

// searchError exposes Jira's message only for rejected queries. Authentication,
// authorization and deployment errors remain internal.
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
	retryAfter string
	detail     string
}

func (e *responseError) Error() string {
	if e.detail != "" {
		return fmt.Sprintf("Jira returned %s: %s", e.status, e.detail)
	}
	return fmt.Sprintf("Jira returned %s", e.status)
}

// userMessage flattens Jira's error envelope into a stable line.
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

// authorize attaches the configured credential.
func (c *Client) authorize(req *http.Request) error {
	switch {
	case c.tokens != nil:
		tok, err := c.tokens.Token()
		if err != nil {
			return fmt.Errorf("jira oauth: %w", err)
		}
		tok.SetAuthHeader(req)
	case c.token != "":
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	return nil
}

// do applies the shared request and response policy. It never retries.
func (c *Client) do(ctx context.Context, method, endpoint string, body []byte, dst any) error {
	resp, err := c.send(ctx, method, endpoint, body)
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
			retryAfter: resp.Header.Get("Retry-After"),
		}
	}
	dec := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes))
	// Preserve large numeric custom fields for extractor scripts.
	dec.UseNumber()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("decode Jira response: %w", err)
	}
	return nil
}

func (c *Client) send(ctx context.Context, method, endpoint string, body []byte) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if err := c.authorize(req); err != nil {
		return nil, err
	}
	return c.http.Do(req)
}

// restEndpoint preserves a configured Jira context path such as /jira.
func (c *Client) restEndpoint(parts ...string) *url.URL {
	return c.restURL.JoinPath(parts...)
}

// BaseURL reports the configured web base, the authority for which links count
// as this deployment's.
func (c *Client) BaseURL() string { return c.webURL.String() }

func (c *Client) browseURL(key string) string {
	return c.webURL.JoinPath("browse", key).String()
}
