package jiradc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/dnswlt/roadie/internal/tracker"
)

func TestSearch(t *testing.T) {
	var got searchRequest
	requests := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost || r.URL.Path != "/rest/api/2/search" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer secret" {
			t.Fatalf("Authorization = %q", auth)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"startAt": 20, "maxResults": 2, "total": 23,
			"issues": []any{
				map[string]any{"id": "101", "key": "PAY-1", "fields": map[string]any{
					"summary": "Payment flow", "issuetype": map[string]string{"name": "Epic"},
					"status": map[string]string{"name": "In Progress"},
				}},
				map[string]any{"id": "102", "key": "PAY-2", "fields": map[string]any{
					"summary": "Retries", "issuetype": map[string]string{"name": "Story"},
					"status": map[string]string{"name": "To Do"},
				}},
			},
		})
	}))
	defer ts.Close()

	c, err := New(Config{BaseURL: ts.URL, Token: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	page, err := c.Search(context.Background(), "project = PAY", "20", 2)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("requests = %d", requests)
	}
	if got.JQL != "project = PAY" || got.StartAt != 20 || got.MaxResults != 2 {
		t.Fatalf("search request = %+v", got)
	}
	if want := []string{"summary", "issuetype", "status"}; !reflect.DeepEqual(got.Fields, want) {
		t.Fatalf("fields = %v, want %v", got.Fields, want)
	}
	if page.Next != "22" || len(page.Issues) != 2 {
		t.Fatalf("page = %+v", page)
	}
	if issue := page.Issues[0]; issue.Title != "Payment flow" || issue.Type != "Epic" || issue.Status != "In Progress" || issue.URL != ts.URL+"/browse/PAY-1" {
		t.Fatalf("issue = %+v", issue)
	}
}

func TestSearchLastPage(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"startAt":2,"maxResults":2,"total":3,"issues":[{"id":"3","key":"A-3","fields":{"summary":"Last","issuetype":{"name":"Task"},"status":{"name":"Done"}}}]}`))
	}))
	defer ts.Close()
	c, _ := New(Config{BaseURL: ts.URL})
	page, err := c.Search(context.Background(), "", "2", 2)
	if err != nil {
		t.Fatal(err)
	}
	if page.Next != "" {
		t.Fatalf("next = %q", page.Next)
	}
}

func TestSearchEmptyPageStopsDespiteStaleTotal(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"startAt":20,"maxResults":10,"total":30,"issues":[]}`))
	}))
	defer ts.Close()
	c, _ := New(Config{BaseURL: ts.URL})
	page, err := c.Search(context.Background(), "", "20", 10)
	if err != nil {
		t.Fatal(err)
	}
	if page.Next != "" {
		t.Fatalf("next = %q", page.Next)
	}
}

func TestSearchNotFoundIsNotAnIssueNotFound(t *testing.T) {
	ts := httptest.NewServer(http.NotFoundHandler())
	defer ts.Close()
	c, _ := New(Config{BaseURL: ts.URL})
	_, err := c.Search(context.Background(), "", "", 10)
	if err == nil || errors.Is(err, tracker.ErrNotFound) {
		t.Fatalf("error = %v", err)
	}
}

// A rejected query is only actionable in Jira's own words, so a 400 carrying
// Jira's error envelope becomes a tracker.QueryError the server will show. The
// other cases must NOT: a body that isn't Jira's envelope may be a proxy's
// HTML, and 401/403/404/5xx are deployment faults — surfacing those as a query
// error would send every user hunting a JQL bug that isn't there.
func TestSearchQueryErrorCarriesJiraMessage(t *testing.T) {
	const jql = `{"errorMessages":["Error in the JQL Query: Expecting operator but got 'AN'."],"errors":{}}`

	tests := []struct {
		name    string
		status  int
		body    string
		message string // "" = expect a plain error, not a QueryError
	}{
		{"jql syntax", http.StatusBadRequest, jql, "Error in the JQL Query: Expecting operator but got 'AN'."},
		{"field errors sorted", http.StatusBadRequest, `{"errors":{"jql":"is malformed","project":"unknown"}}`, "jql: is malformed; project: unknown"},
		{"both parts joined", http.StatusBadRequest, `{"errorMessages":["Bad request"],"errors":{"jql":"is malformed"}}`, "Bad request; jql: is malformed"},
		{"html body", http.StatusBadRequest, `<html><body>Gateway rejected</body></html>`, ""},
		{"empty envelope", http.StatusBadRequest, `{"errorMessages":[],"errors":{}}`, ""},
		// Deployment faults, never the query's: an expired token must not
		// reach the user as a complaint about their JQL.
		{"expired token", http.StatusUnauthorized, `{"errorMessages":["Client must be authenticated."],"errors":{}}`, ""},
		{"permission denied", http.StatusForbidden, `{"errorMessages":["You do not have permission."],"errors":{}}`, ""},
		{"wrong base URL", http.StatusNotFound, `{"errorMessages":["Not found."],"errors":{}}`, ""},
		{"server error", http.StatusInternalServerError, jql, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer ts.Close()
			c, _ := New(Config{BaseURL: ts.URL})
			_, err := c.Search(context.Background(), "project = PAY AN x", "", 10)

			var qErr *tracker.QueryError
			if !errors.As(err, &qErr) {
				if tc.message != "" {
					t.Fatalf("error = %v, want QueryError %q", err, tc.message)
				}
				if err == nil {
					t.Fatal("error = nil, want a failure")
				}
				return
			}
			if tc.message == "" {
				t.Fatalf("error = QueryError %q, want a plain error", qErr.Message)
			}
			if qErr.Message != tc.message {
				t.Fatalf("message = %q, want %q", qErr.Message, tc.message)
			}
		})
	}
}

func TestGetIssue(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/jira/rest/api/2/issue/PAY-1" || r.URL.Query().Get("fields") != "summary,issuetype,status" {
			t.Fatalf("URL = %s", r.URL.String())
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"101","key":"PAY-1","fields":{"summary":"Payment flow","issuetype":{"name":"Epic"},"status":{"name":"In Progress"}}}`))
	}))
	defer ts.Close()
	c, _ := New(Config{BaseURL: ts.URL + "/jira/"})
	issue, err := c.GetIssue(context.Background(), "PAY-1")
	if err != nil {
		t.Fatal(err)
	}
	if issue.URL != ts.URL+"/jira/browse/PAY-1" {
		t.Fatalf("URL = %q", issue.URL)
	}
}

func TestGetIssueNotFound(t *testing.T) {
	ts := httptest.NewServer(http.NotFoundHandler())
	defer ts.Close()
	c, _ := New(Config{BaseURL: ts.URL})
	_, err := c.GetIssue(context.Background(), "NOPE-1")
	if !errors.Is(err, tracker.ErrNotFound) {
		t.Fatalf("error = %v", err)
	}
}

// oauthJira is a Jira stand-in that only answers requests bearing a token it
// issued itself, so a test asserting on issues also proves the grant ran. Each
// token is minted with a distinct value; tokens counts how often the grant ran.
type oauthJira struct {
	mux    *http.ServeMux
	tokens int
	// expiresIn is what the token endpoint claims. Anything under oauth2's
	// 10s expiry margin makes every request see an expired cached token, which
	// is how "refetch when it expires" is pinned without waiting for a clock.
	expiresIn int
	issued    string
	scope     string
	basicAuth [2]string
	grantType string
}

func newOAuthJira(t *testing.T, expiresIn int) (*oauthJira, *httptest.Server) {
	t.Helper()
	j := &oauthJira{mux: http.NewServeMux(), expiresIn: expiresIn}
	j.mux.HandleFunc("POST /oauth/token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("token request form: %v", err)
		}
		user, pass, _ := r.BasicAuth()
		j.basicAuth = [2]string{user, pass}
		j.grantType = r.PostForm.Get("grant_type")
		j.scope = r.PostForm.Get("scope")
		j.tokens++
		j.issued = fmt.Sprintf("minted-%d", j.tokens)
		writeJSON(w, map[string]any{
			"access_token": j.issued, "token_type": "Bearer", "expires_in": j.expiresIn,
		})
	})
	j.mux.HandleFunc("POST /rest/api/2/search", func(w http.ResponseWriter, r *http.Request) {
		if got, want := r.Header.Get("Authorization"), "Bearer "+j.issued; got != want {
			// Not t.Fatalf: this runs on the server's goroutine.
			t.Errorf("Authorization = %q, want %q", got, want)
			writeError(w, http.StatusUnauthorized)
			return
		}
		writeJSON(w, map[string]any{"startAt": 0, "maxResults": 50, "total": 1, "issues": []any{
			map[string]any{"id": "1", "key": "PAY-1", "fields": map[string]any{
				"summary": "Payment flow", "issuetype": map[string]string{"name": "Epic"},
				"status": map[string]string{"name": "In Progress"},
			}},
		}})
	})
	ts := httptest.NewServer(j.mux)
	t.Cleanup(ts.Close)
	return j, ts
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int) {
	w.WriteHeader(status)
	w.Write([]byte(`{"errorMessages":["Client must be authenticated."],"errors":{}}`))
}

// A long-lived token is fetched once and reused: the grant must not run per
// request. A PAT set alongside OAuth is ignored, not sent.
func TestOAuthClientCredentials(t *testing.T) {
	j, ts := newOAuthJira(t, 3600)
	c, err := New(Config{
		BaseURL: ts.URL,
		Token:   "ignored-pat",
		OAuth: OAuthConfig{
			ClientID:     "roadie",
			ClientSecret: "s3cret",
			TokenURL:     ts.URL + "/oauth/token",
			Scopes:       []string{"read:jira-work", "read:me"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		page, err := c.Search(context.Background(), "project = PAY", "", 50)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Issues) != 1 {
			t.Fatalf("issues = %+v", page.Issues)
		}
	}
	if j.tokens != 1 {
		t.Fatalf("token requests = %d, want 1 (cached)", j.tokens)
	}
	if j.grantType != "client_credentials" {
		t.Fatalf("grant_type = %q", j.grantType)
	}
	if j.basicAuth != [2]string{"roadie", "s3cret"} {
		t.Fatalf("client authentication = %q", j.basicAuth)
	}
	if j.scope != "read:jira-work read:me" {
		t.Fatalf("scope = %q", j.scope)
	}
}

func TestOAuthRefetchesExpiredToken(t *testing.T) {
	j, ts := newOAuthJira(t, 5) // inside oauth2's expiry margin: always stale
	c, err := New(Config{BaseURL: ts.URL, OAuth: OAuthConfig{
		ClientID: "roadie", ClientSecret: "s3cret", TokenURL: ts.URL + "/oauth/token",
	}})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := c.Search(context.Background(), "", "", 50); err != nil {
			t.Fatal(err)
		}
	}
	if j.tokens != 2 {
		t.Fatalf("token requests = %d, want 2 (one per expired token)", j.tokens)
	}
	if j.scope != "" {
		t.Fatalf("scope = %q, want none", j.scope)
	}
}

// A token endpoint that refuses the client is an operator fault, so it must not
// reach the user as a complaint about their JQL.
func TestOAuthTokenEndpointFailure(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":"invalid_client"}`))
	}))
	defer ts.Close()
	c, err := New(Config{BaseURL: ts.URL, OAuth: OAuthConfig{
		ClientID: "roadie", ClientSecret: "wrong", TokenURL: ts.URL + "/oauth/token",
	}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Search(context.Background(), "project = PAY", "", 50)
	var qErr *tracker.QueryError
	if err == nil || errors.As(err, &qErr) {
		t.Fatalf("error = %v, want a plain failure", err)
	}
}

// Half a grant is a misconfiguration to fail startup on, not to discover on the
// first search.
func TestOAuthValidation(t *testing.T) {
	for _, o := range []OAuthConfig{
		{TokenURL: "https://sso.example.com/token"},
		{ClientID: "roadie", TokenURL: "https://sso.example.com/token"},
		{ClientSecret: "s3cret", TokenURL: "https://sso.example.com/token"},
		{ClientID: "roadie", ClientSecret: "s3cret", TokenURL: "sso.example.com/token"},
		{ClientID: "roadie", ClientSecret: "s3cret", TokenURL: "ftp://sso.example.com/token"},
	} {
		if _, err := New(Config{BaseURL: "https://jira.example.com", OAuth: o}); err == nil {
			t.Errorf("New(%+v) succeeded", o)
		}
	}
	// An unset token URL leaves the PAT in charge, whatever else is set.
	c, err := New(Config{BaseURL: "https://jira.example.com", Token: "pat",
		OAuth: OAuthConfig{ClientID: "roadie", ClientSecret: "s3cret"}})
	if err != nil {
		t.Fatal(err)
	}
	if c.tokens != nil || c.token != "pat" {
		t.Fatalf("credentials = (%v, %q), want the PAT alone", c.tokens, c.token)
	}
}

func TestValidation(t *testing.T) {
	for _, base := range []string{"", "jira.example.com", "ftp://jira.example.com", "https://jira.example.com?q=x", "https://user:pass@jira.example.com"} {
		if _, err := New(Config{BaseURL: base}); err == nil {
			t.Errorf("New(%q) succeeded", base)
		}
	}
	c, err := New(Config{BaseURL: "https://jira.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Search(context.Background(), "", "not-a-cursor", 50); err == nil {
		t.Error("invalid continuation succeeded")
	}
	if _, err := c.Search(context.Background(), "", "", 0); err == nil {
		t.Error("zero page size succeeded")
	}
	if _, err := c.GetIssue(context.Background(), "../search"); err == nil {
		t.Error("invalid issue ID succeeded")
	}
}
