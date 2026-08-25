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

// Config describes one Jira Data Center deployment. Credentials are optional so
// the local development mock can run without authentication.
//
// The two credential kinds are alternatives, and OAuth wins when both are set:
// Token is a static personal access token, OAuth mints short-lived ones.
type Config struct {
	// BaseURL is the deployment as a browser reaches it, and the authority for
	// issue links: the frontend reconciles an item's description links against
	// the URL an issue carries, so the wrong host matches nothing.
	BaseURL string
	// RestURL is where the REST API answers, for deployments that publish it on
	// a different host from the web UI. Empty means BaseURL serves both.
	RestURL string
	Token   string
	OAuth   OAuthConfig
	Client  *http.Client
}

// OAuthConfig is an OAuth 2.0 client-credentials grant, in force when TokenURL
// is set. Roadie authenticates as itself rather than as a user, so there is no
// interactive flow and no refresh token: the token source fetches an access
// token on first use and again once it expires.
type OAuthConfig struct {
	ClientID     string
	ClientSecret string
	TokenURL     string
	// Scopes the authorization server needs before it will issue a token Jira
	// accepts. Many deployments need none.
	Scopes []string
}

// Client translates Jira's REST representation and offset paging into the
// deliberately smaller tracker.Client contract.
type Client struct {
	// webURL builds the links people follow; restURL is where requests go. They
	// are the same URL unless the deployment splits the two.
	webURL  *url.URL
	restURL *url.URL
	// Exactly one of these carries credentials, or neither does: tokens is nil
	// unless OAuth is configured, and configuring OAuth clears token.
	token  string
	tokens oauth2.TokenSource
	http   *http.Client
}

var _ tracker.Client = (*Client)(nil)

// New validates the deployment URLs once, so request methods can safely append
// paths to Jira installations both at a host root and below a context path.
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
	c := &Client{webURL: web, restURL: rest, token: strings.TrimSpace(cfg.Token), http: httpClient}
	if cfg.OAuth.enabled() {
		tokens, err := cfg.OAuth.tokenSource(httpClient)
		if err != nil {
			return nil, err
		}
		// A PAT left in the environment alongside OAuth must not silently decide
		// authentication; the caller reports which one won.
		c.token, c.tokens = "", tokens
	}
	return c, nil
}

// parseBaseURL validates one configured Jira URL and strips a trailing slash so
// JoinPath is predictable. what names the URL in the error, since a deployment
// can configure two of them.
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

// enabled treats the token URL as the switch: an authorization server is the one
// part of a client-credentials grant with no default.
func (o OAuthConfig) enabled() bool { return strings.TrimSpace(o.TokenURL) != "" }

// tokenSource validates the grant as a whole — half a credential is a
// misconfiguration to fail startup on, not to discover on the first search —
// and returns a source that caches the access token until it expires.
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
		// AuthStyleAutoDetect (the zero value) tries HTTP Basic first, then form
		// parameters, and remembers what the server accepted — so which of the
		// two spellings a deployment wants is not another thing to configure.
	}
	// The context carries our HTTP client, and with it the timeout. Not a request
	// context: a token outlives the request that first needed it.
	ctx := context.WithValue(context.Background(), oauth2.HTTPClient, httpClient)
	// The source caches the token and refetches on expiry only.
	return cfg.TokenSource(ctx), nil
}

// displayFields are the Jira fields tracker.Issue is built from. Every read
// asks for them, and a by-key fetch unions them with whatever the caller wants
// on top, so an extractor script cannot blank the identity columns by leaving
// them out of JIRA_FIELDS.
var displayFields = []string{"summary", "issuetype", "status"}

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

// keysPerBatch is how many keys go into one `key in (...)` search. The page cap
// is per installation (jira.search.views.default.max) and Jira Cloud caps
// maxResults at 100, so 100 is the portable choice; the fetcher is never in a
// hurry, so headroom above it buys nothing. searchKeys rejects a short page,
// which catches an installation capped lower still.
const keysPerBatch = 100

// maxSalvageRounds bounds the retry loop below. One retry is the observed case,
// because Jira names every unknown key at once — that measurement is what makes
// a small cap safe. A deployment that named them one at a time would need a
// round per dead key; rather than loop or storm, salvage gives up after this
// many and says so.
const maxSalvageRounds = 3

// jiraKey is Jira's default issue-key grammar. Keys are interpolated into JQL,
// so anything that is not a key is dropped before it can become syntax — which
// also reports as "not found", the answer a nonsense key deserves.
var jiraKey = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*$`)

// namedKey finds the issue keys Jira quotes in a rejection, e.g. "An issue with
// key 'PAY-9' does not exist for field 'key'." The key stays quoted whatever
// the deployment's locale, which is what makes reading it safer than it looks;
// the caller additionally discards any key it did not send.
var namedKey = regexp.MustCompile(`['"]([A-Za-z][A-Za-z0-9_]*-[1-9][0-9]*)['"]`)

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
		if key = strings.TrimSpace(key); jiraKey.MatchString(key) {
			usable = append(usable, key)
		}
	}

	issues := []tracker.FetchedIssue{}
	for batch := range slices.Chunk(usable, keysPerBatch) {
		got, err := c.fetchBatch(ctx, batch, fields)
		if err != nil {
			return nil, err
		}
		issues = append(issues, got...)
	}
	return issues, nil
}

// fetchBatch asks for a batch and, when Jira rejects it, asks again without the
// keys Jira named.
//
// JQL rejects the *entire* query over one missing or invisible key, so without
// this a single dead link costs the caller the other ninety-nine and the check
// under-reports the roadmap silently. Jira names every unknown key at once, so
// this costs one more request whatever the number of dead links.
//
// Only keys this batch sent may be dropped. A 400 naming none of them is a
// different failure — malformed JQL, `key` unavailable — and it returns with
// Jira's wording rather than being retried, which would loop.
func (c *Client) fetchBatch(ctx context.Context, batch, fields []string) ([]tracker.FetchedIssue, error) {
	sent := batch
	for range maxSalvageRounds {
		if len(sent) == 0 {
			return nil, nil
		}
		issues, err := c.withBackoff(ctx, func() ([]tracker.FetchedIssue, error) {
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
			// Rejected, but not over any key we sent: not ours to salvage.
			return nil, searchError(err)
		}
		sent = remaining
	}
	return nil, fmt.Errorf("Jira kept rejecting a batch of %d issue keys after %d attempts", len(batch), maxSalvageRounds)
}

// dropNamed returns keys minus those the rejection named. Matching is
// case-insensitive because Jira echoes a key as the query spelled it.
func dropNamed(keys []string, detail string) []string {
	named := map[string]bool{}
	for _, m := range namedKey.FindAllStringSubmatch(detail, -1) {
		named[strings.ToUpper(m[1])] = true
	}
	if len(named) == 0 {
		return keys
	}
	kept := make([]string, 0, len(keys))
	for _, key := range keys {
		if !named[strings.ToUpper(key)] {
			kept = append(kept, key)
		}
	}
	return kept
}

// Waiting out a rate limit, for the by-key fetch only. Roadie makes those from
// one background goroutine (internal/recon), which is why waiting is acceptable
// there and nowhere else: no user is watching it, and no other request is
// delayed by it. An interactive search on the same client still fails fast.
const (
	maxAttempts  = 4
	maxTotalWait = 30 * time.Second
)

// baseRetryDelay doubles per attempt when Jira names no Retry-After. A variable
// so a test need not spend the real delays.
var baseRetryDelay = 500 * time.Millisecond

// maxRetryAfterSeconds is the largest delta-seconds a Duration can hold. Beyond
// it the multiplication below wraps — to a negative delay, which would retry
// *immediately* against a deployment asking for the opposite.
const maxRetryAfterSeconds = int64(math.MaxInt64) / int64(time.Second)

// retryable is what a deployment returns when it wants us to slow down or come
// back: 429 outright, 503 when Jira sheds load. Never 400 — that one carries the
// key names salvage reads, and retrying it unchanged would loop.
func retryable(err error) (*responseError, bool) {
	var resp *responseError
	if !errors.As(err, &resp) {
		return nil, false
	}
	return resp, resp.statusCode == http.StatusTooManyRequests || resp.statusCode == http.StatusServiceUnavailable
}

// retryAfterHeader reads the delay Jira asks for. RFC 9110 allows either
// delta-seconds or an HTTP date, and both are honoured: coming back before a
// deployment said to is the one thing this must not do. A date already past
// means now; anything too far out to represent returns the longest Duration
// there is, so the caller's deadline refuses it rather than a wrapped value
// being mistaken for a short wait. (time.Until saturates, so the date form
// needs no such guard.)
func retryAfterHeader(raw string) (time.Duration, bool) {
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
	return max(time.Until(when), 0), true
}

// withBackoff runs one by-key search, waiting and repeating while Jira asks it
// to. Bounded both ways, so a wedged deployment stalls the fetcher for a known
// time rather than forever.
func (c *Client) withBackoff(ctx context.Context, run func() ([]tracker.FetchedIssue, error)) ([]tracker.FetchedIssue, error) {
	deadline := time.Now().Add(maxTotalWait)
	var lastErr error
	for attempt := range maxAttempts {
		issues, err := run()
		resp, wantsRetry := retryable(err)
		if !wantsRetry {
			return issues, err
		}
		lastErr = err
		// Waiting is only worth anything if an attempt follows it. On the last
		// one there is none, and the sole fetcher would stall for a delay it
		// can no longer spend.
		if attempt == maxAttempts-1 {
			break
		}
		delay, ok := retryAfterHeader(resp.retryAfter)
		if !ok {
			delay = baseRetryDelay << attempt
		}
		if time.Now().Add(delay).After(deadline) {
			return nil, fmt.Errorf("Jira is rate limiting and asked for longer than %s: %w", maxTotalWait, err)
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, fmt.Errorf("Jira kept rate limiting after %d attempts: %w", maxAttempts, lastErr)
}

// searchKeys is one `key in (...)` request. Keys are already validated against
// jiraKey, so quoting them is enough to keep the query well formed.
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
	// Decoded as plain JSON, not into a struct: a script reads the issue as
	// Jira nests it, so the whole object is what has to survive.
	var result struct {
		Issues []map[string]any `json:"issues"`
	}
	if err := c.do(ctx, http.MethodPost, c.restEndpoint("rest", "api", "2", "search").String(), body, &result); err != nil {
		return nil, err
	}
	// Unknown keys are a 400, never a short page, so a 200 must carry exactly
	// as many issues as the batch had keys. Fewer means the deployment's page
	// cap truncated the result, and reporting the remainder as not found would
	// tell a roadmap its live links are dead.
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

// normalizeFetched derives the neutral projection from the raw issue rather
// than decoding it a second time, so there is one representation and not two
// that can disagree. The display fields are always requested, so what is read
// here cannot be defeated by a script's JIRA_FIELDS.
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

// rawString and rawObject walk decoded JSON. A member Jira omitted or sent as
// another type reads as empty rather than failing the whole fetch — a custom
// field is absent whenever the deployment does not define it.
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

// normalize is the only place Jira's field nesting crosses into the generic
// model. The browser URL is constructed because Jira's self link targets REST —
// on a split deployment, a different host altogether.
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
	// retryAfter is Jira's header verbatim, empty when absent. Kept on the
	// error rather than acted on here: only the fetcher waits.
	retryAfter string
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

// authorize attaches the configured credential, if there is one. An OAuth token
// comes from a cache that refetches only once the current token expires, so on
// all but the first request this is a mutex and an expiry check.
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

// do owns the shared wire policy: JSON headers, bearer authentication, bounded
// error text and response decoding. It intentionally does not interpret HTTP
// statuses, and it never waits: an interactive search must fail fast and say
// so. Backing off is the by-key fetch's business alone — see withBackoff.
//
// body is bytes rather than a Reader so that a caller which does retry can send
// it again.
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
	// A raw field map decodes into `any`, where the default is float64 and a
	// large Jira id would lose digits before the extractor ever sees it.
	// Irrelevant to the typed decodes, which never consult this.
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

// browseURL is built from the web base even when the REST API answers on another
// host: this is the link a person follows, and the identity the frontend matches
// an item's description links against.
func (c *Client) browseURL(key string) string {
	return c.webURL.JoinPath("browse", key).String()
}
