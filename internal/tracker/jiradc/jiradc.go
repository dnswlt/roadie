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
	if err := c.do(ctx, http.MethodPost, c.restEndpoint("rest", "api", "2", "search").String(), bytes.NewReader(body), &result); err != nil {
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
	if err := c.authorize(req); err != nil {
		return err
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
