package jiradc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

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
	// This text is what the server logs, so the provider's own refusal has to
	// survive into it; the log is all a deployment has to go on.
	if !strings.Contains(err.Error(), "invalid_client") {
		t.Errorf("error %q does not carry the provider's refusal", err)
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

// An organisation can publish the REST API on a different host from the web UI.
// Requests must then go to the REST host while issue links keep naming the web
// one — a link into the API host would be unreachable for a person, and would
// reconcile against nothing, since the frontend matches an item's description
// links against the URL an issue carries.
func TestSplitRESTAndWebHosts(t *testing.T) {
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("web host received %s %s; only the REST host may be called", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusTeapot)
	}))
	defer web.Close()
	rest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api-context/rest/api/2/search":
			w.Write([]byte(`{"startAt":0,"maxResults":50,"total":1,"issues":[{"id":"1","key":"PAY-1","fields":{"summary":"Payment flow","issuetype":{"name":"Epic"},"status":{"name":"In Progress"}}}]}`))
		case "/api-context/rest/api/2/issue/PAY-1":
			w.Write([]byte(`{"id":"1","key":"PAY-1","fields":{"summary":"Payment flow","issuetype":{"name":"Epic"},"status":{"name":"To Do"}}}`))
		default:
			t.Errorf("unexpected REST path %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer rest.Close()

	c, err := New(Config{BaseURL: web.URL + "/jira/", RestURL: rest.URL + "/api-context"})
	if err != nil {
		t.Fatal(err)
	}
	page, err := c.Search(context.Background(), "project = PAY", "", 50)
	if err != nil {
		t.Fatal(err)
	}
	want := web.URL + "/jira/browse/PAY-1"
	if len(page.Issues) != 1 || page.Issues[0].URL != want {
		t.Fatalf("search issue = %+v, want URL %q", page.Issues, want)
	}
	issue, err := c.GetIssue(context.Background(), "PAY-1")
	if err != nil {
		t.Fatal(err)
	}
	if issue.URL != want {
		t.Fatalf("issue URL = %q, want %q", issue.URL, want)
	}
}

// With no REST URL configured, one host serves both — the single-host default.
func TestRESTDefaultsToBaseURL(t *testing.T) {
	c, err := New(Config{BaseURL: "https://jira.example.com/jira"})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := c.restEndpoint("rest", "api", "2", "search").String(), "https://jira.example.com/jira/rest/api/2/search"; got != want {
		t.Fatalf("REST endpoint = %q, want %q", got, want)
	}
	if got, want := c.browseURL("PAY-1"), "https://jira.example.com/jira/browse/PAY-1"; got != want {
		t.Fatalf("browse URL = %q, want %q", got, want)
	}
}

func TestValidation(t *testing.T) {
	bad := []string{"", "jira.example.com", "ftp://jira.example.com", "https://jira.example.com?q=x", "https://user:pass@jira.example.com"}
	for _, base := range bad {
		if _, err := New(Config{BaseURL: base}); err == nil {
			t.Errorf("New(base %q) succeeded", base)
		}
	}
	// Both URLs are held to the same rules; an empty REST URL is the one
	// difference, since that is how a single-host deployment is expressed.
	for _, rest := range bad[1:] {
		if _, err := New(Config{BaseURL: "https://jira.example.com", RestURL: rest}); err == nil {
			t.Errorf("New(REST %q) succeeded", rest)
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

// jiraFixture answers by-key searches from a small issue table.
type jiraFixture struct {
	issues   map[string]map[string]any
	rejects  map[string]bool
	searches [][]string // fields requested, one entry per search
	jqls     []string   // the JQL of each search, in order
}

func (f *jiraFixture) handler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/rest/api/2/search" {
			http.NotFound(w, r)
			return
		}
		var req searchRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		f.searches = append(f.searches, req.Fields)
		f.jqls = append(f.jqls, req.JQL)
		keys := keysInJQL(req.JQL)
		var rejected []string
		for _, key := range keys {
			if f.rejects[key] {
				rejected = append(rejected, fmt.Sprintf("An issue with key '%s' does not exist for field 'key'.", key))
			}
		}
		if len(rejected) > 0 {
			writeJiraJSON(w, http.StatusBadRequest,
				map[string]any{"errorMessages": rejected, "errors": map[string]string{}})
			return
		}
		issues := []map[string]any{}
		for _, key := range keys {
			if fields, ok := f.issues[key]; ok {
				issues = append(issues, map[string]any{"id": "1", "key": key, "fields": fields})
			}
		}
		writeJiraJSON(w, http.StatusOK, map[string]any{"issues": issues})
	})
}

// keysInJQL pulls the quoted keys back out of `key in ("A", "B")`.
func keysInJQL(jql string) []string {
	var keys []string
	for _, part := range strings.Split(strings.Trim(strings.TrimPrefix(jql, "key in ("), ")"), ",") {
		if key := strings.Trim(strings.TrimSpace(part), `"`); key != "" {
			keys = append(keys, key)
		}
	}
	return keys
}

func writeJiraJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeJiraError(w http.ResponseWriter, status int, msg string) {
	writeJiraJSON(w, status, map[string]any{"errorMessages": []string{msg}})
}

func namedValue(name string) map[string]any { return map[string]any{"name": name} }

// rawFields reaches into the raw issue the way a script does.
func rawFields(raw map[string]any) map[string]any { return rawObject(raw, "fields") }

func newFixtureClient(t *testing.T, f *jiraFixture) *Client {
	t.Helper()
	ts := httptest.NewServer(f.handler(t))
	t.Cleanup(ts.Close)
	c, err := New(Config{BaseURL: ts.URL})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestFetchIssues(t *testing.T) {
	f := &jiraFixture{issues: map[string]map[string]any{
		"PAY-1": {
			"summary": "Payment flow", "issuetype": namedValue("Epic"), "status": namedValue("In Progress"),
			"customfield_10430": "2026-04-12", "fixVersions": []any{map[string]any{"name": "26.3"}},
		},
		"PAY-2": {"summary": "Retries", "issuetype": namedValue("Story"), "status": namedValue("To Do")},
	}}
	c := newFixtureClient(t, f)

	found, err := c.FetchIssues(context.Background(), []string{"PAY-1", "PAY-2"}, []string{"customfield_10430", "fixVersions"})
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 2 {
		t.Fatalf("issues = %+v", found)
	}

	// The neutral projection is derived from the same raw map the script reads.
	got := found[0].Issue
	if got.Key != "PAY-1" || got.Title != "Payment flow" || got.Type != "Epic" || got.Status != "In Progress" {
		t.Fatalf("issue = %+v", got)
	}
	if got.URL != c.browseURL("PAY-1") {
		t.Fatalf("URL = %q", got.URL)
	}
	// Raw fields ride along, nested as Jira sent them.
	if rawFields(found[0].Raw)["customfield_10430"] != "2026-04-12" {
		t.Fatalf("raw fields = %+v", found[0].Raw)
	}
	versions, ok := rawFields(found[0].Raw)["fixVersions"].([]any)
	if !ok || len(versions) != 1 {
		t.Fatalf("fixVersions = %+v", rawFields(found[0].Raw)["fixVersions"])
	}

	// Display fields are always asked for, so JIRA_FIELDS cannot blank them,
	// and they are not requested twice when a script names one anyway.
	if len(f.searches) != 1 {
		t.Fatalf("searches = %v", f.searches)
	}
	want := []string{"summary", "issuetype", "status", "customfield_10430", "fixVersions"}
	if !reflect.DeepEqual(f.searches[0], want) {
		t.Fatalf("fields = %v, want %v", f.searches[0], want)
	}
}

func TestFetchIssuesUnionsDisplayFieldsOnce(t *testing.T) {
	f := &jiraFixture{issues: map[string]map[string]any{
		"PAY-1": {"summary": "Payment flow", "issuetype": namedValue("Epic"), "status": namedValue("To Do")},
	}}
	c := newFixtureClient(t, f)
	if _, err := c.FetchIssues(context.Background(), []string{"PAY-1"}, []string{"status", " summary ", "", "duedate"}); err != nil {
		t.Fatal(err)
	}
	want := []string{"summary", "issuetype", "status", "duedate"}
	if !reflect.DeepEqual(f.searches[0], want) {
		t.Fatalf("fields = %v, want %v", f.searches[0], want)
	}
}

func TestFetchIssuesDropsKeysJiraNames(t *testing.T) {
	f := &jiraFixture{
		issues: map[string]map[string]any{
			"PAY-1": {"summary": "Payment flow", "issuetype": namedValue("Epic"), "status": namedValue("To Do")},
			"PAY-3": {"summary": "Refunds", "issuetype": namedValue("Story"), "status": namedValue("Done")},
		},
		rejects: map[string]bool{"PAY-2": true},
	}
	c := newFixtureClient(t, f)

	found, err := c.FetchIssues(context.Background(), []string{"PAY-1", "PAY-2", "PAY-3"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 2 || found[0].Issue.Key != "PAY-1" || found[1].Issue.Key != "PAY-3" {
		t.Fatalf("issues = %+v", found)
	}
	if len(f.jqls) != 2 {
		t.Fatalf("requests = %d, want 2", len(f.jqls))
	}
}

// Jira names every unknown key at once, so salvage costs one retry.
func TestFetchIssuesSalvageCostIsFlat(t *testing.T) {
	for _, dead := range []int{1, 5, 25, keysPerBatch} {
		f := &jiraFixture{issues: map[string]map[string]any{}, rejects: map[string]bool{}}
		keys := make([]string, keysPerBatch)
		for i := range keys {
			keys[i] = fmt.Sprintf("PAY-%d", i+1)
			f.issues[keys[i]] = map[string]any{"summary": "x", "issuetype": namedValue("Story"), "status": namedValue("To Do")}
		}
		for i := range dead {
			f.rejects[keys[i]] = true
			delete(f.issues, keys[i])
		}
		c := newFixtureClient(t, f)
		found, err := c.FetchIssues(context.Background(), keys, nil)
		if err != nil {
			t.Fatalf("%d dead: %v", dead, err)
		}
		if len(found) != len(keys)-dead {
			t.Fatalf("%d dead: resolved %d, want %d", dead, len(found), len(keys)-dead)
		}
		if len(f.jqls) != 2 {
			t.Fatalf("%d dead: %d requests, want 2", dead, len(f.jqls))
		}
	}
}

func TestFetchIssuesSurfacesUnattributableRejection(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJiraError(w, http.StatusBadRequest, "Field 'key' does not exist or is not searchable.")
	}))
	defer ts.Close()
	c, err := New(Config{BaseURL: ts.URL})
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.FetchIssues(context.Background(), []string{"PAY-1", "PAY-2"}, nil)
	if err == nil || !strings.Contains(err.Error(), "not searchable") {
		t.Fatalf("err = %v", err)
	}
}

// Jira must not be able to make us drop a key we never asked about.
func TestFetchIssuesOnlyDropsKeysItSent(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJiraError(w, http.StatusBadRequest,
			"An issue with key 'OTHER-42' does not exist for field 'key'.")
	}))
	defer ts.Close()
	c, err := New(Config{BaseURL: ts.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.FetchIssues(context.Background(), []string{"PAY-1"}, nil); err == nil {
		t.Fatal("want the rejection to surface")
	}
}

func TestFetchIssuesGivesUpWhenRejectionsNeverResolve(t *testing.T) {
	var sent [][]string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req searchRequest
		json.NewDecoder(r.Body).Decode(&req)
		keys := keysInJQL(req.JQL)
		sent = append(sent, keys)
		writeJiraError(w, http.StatusBadRequest,
			fmt.Sprintf("An issue with key '%s' does not exist for field 'key'.", keys[0]))
	}))
	defer ts.Close()
	c, err := New(Config{BaseURL: ts.URL})
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.FetchIssues(context.Background(), []string{"PAY-1", "PAY-2", "PAY-3", "PAY-4", "PAY-5"}, nil)
	if err == nil {
		t.Fatal("want an error rather than a round per key")
	}
	if len(sent) != maxSalvageRounds {
		t.Fatalf("made %d attempts, cap is %d", len(sent), maxSalvageRounds)
	}
}

func TestFetchIssuesRejectsATruncatedPage(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJiraJSON(w, http.StatusOK, map[string]any{"issues": []any{
			map[string]any{"id": "1", "key": "PAY-1", "fields": map[string]any{"summary": "x"}},
		}})
	}))
	defer ts.Close()
	c, err := New(Config{BaseURL: ts.URL})
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.FetchIssues(context.Background(), []string{"PAY-1", "PAY-2", "PAY-3"}, nil)
	if err == nil || !strings.Contains(err.Error(), "page cap") {
		t.Fatalf("err = %v", err)
	}
}

func TestFetchIssuesDoesNotRetryAuthFailure(t *testing.T) {
	requests := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		writeJiraError(w, http.StatusUnauthorized, "You do not have permission.")
	}))
	defer ts.Close()
	c, err := New(Config{BaseURL: ts.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.FetchIssues(context.Background(), []string{"PAY-1", "PAY-2"}, nil); err == nil {
		t.Fatal("want an error")
	}
	if requests != 1 {
		t.Fatalf("a 401 became %d requests", requests)
	}
}

func TestFetchIssuesChunks(t *testing.T) {
	f := &jiraFixture{issues: map[string]map[string]any{}}
	keys := make([]string, keysPerBatch+3)
	for i := range keys {
		keys[i] = fmt.Sprintf("PAY-%d", i+1)
		f.issues[keys[i]] = map[string]any{"summary": "x", "issuetype": namedValue("Story"), "status": namedValue("To Do")}
	}
	c := newFixtureClient(t, f)
	found, err := c.FetchIssues(context.Background(), keys, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != len(keys) {
		t.Fatalf("issues = %d, want %d", len(found), len(keys))
	}
	if len(f.searches) != 2 {
		t.Fatalf("searches = %d, want 2 batches", len(f.searches))
	}
}

// Keys are interpolated into JQL, so anything that is not a key is dropped
// before it can become syntax — and reads as "not found" to the caller.
func TestFetchIssuesDropsUnusableKeys(t *testing.T) {
	f := &jiraFixture{issues: map[string]map[string]any{
		"PAY-1": {"summary": "Payment flow", "issuetype": namedValue("Epic"), "status": namedValue("To Do")},
	}}
	c := newFixtureClient(t, f)
	found, err := c.FetchIssues(context.Background(),
		[]string{"PAY-1", " PAY-1 ", `PAY-1") OR project = "SECRET`, "not a key", "", "PAY-0", "-7"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 1 || found[0].Issue.Key != "PAY-1" {
		t.Fatalf("issues = %+v", found)
	}
	if len(f.jqls) != 1 || f.jqls[0] != `key in ("PAY-1")` {
		t.Fatalf("jql = %q", f.jqls)
	}
}

// Jira ids can exceed float64's exact range; a script must see the digits Jira
// sent, not a rounded double.
func TestFetchIssuesKeepsNumbersExact(t *testing.T) {
	f := &jiraFixture{issues: map[string]map[string]any{
		"PAY-1": {
			"summary": "x", "issuetype": namedValue("Story"), "status": namedValue("To Do"),
			"customfield_10020": json.RawMessage(`9007199254740993`),
		},
	}}
	c := newFixtureClient(t, f)
	found, err := c.FetchIssues(context.Background(), []string{"PAY-1"}, []string{"customfield_10020"})
	if err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprint(rawFields(found[0].Raw)["customfield_10020"]); got != "9007199254740993" {
		t.Fatalf("number = %s", got)
	}
}

func TestBackoffHonoursRetryAfter(t *testing.T) {
	var attempts int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			w.Header().Set("Retry-After", "0")
			writeJiraError(w, http.StatusTooManyRequests, "Rate limit exceeded.")
			return
		}
		writeJiraJSON(w, http.StatusOK, map[string]any{"issues": []any{
			map[string]any{"id": "1", "key": "PAY-1", "fields": map[string]any{
				"summary": "x", "issuetype": namedValue("Story"), "status": namedValue("To Do")}},
		}})
	}))
	defer ts.Close()
	c, err := New(Config{BaseURL: ts.URL})
	if err != nil {
		t.Fatal(err)
	}
	found, err := c.FetchIssues(context.Background(), []string{"PAY-1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 2 || len(found) != 1 {
		t.Fatalf("attempts = %d, issues = %d", attempts, len(found))
	}
}

// A 429 must never take the salvage path: dropping keys or splitting the batch
// would answer a rate limit with more requests.
func TestRateLimitIsNotSalvaged(t *testing.T) {
	var jqls []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req searchRequest
		json.NewDecoder(r.Body).Decode(&req)
		jqls = append(jqls, req.JQL)
		w.Header().Set("Retry-After", "0")
		// Names a key, so a salvage path that keyed off the text rather than
		// the status would happily drop it and retry a smaller batch.
		writeJiraError(w, http.StatusTooManyRequests,
			"Rate limit exceeded on 'PAY-1'.")
	}))
	defer ts.Close()
	c, err := New(Config{BaseURL: ts.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.FetchIssues(context.Background(), []string{"PAY-1", "PAY-2"}, nil); err == nil {
		t.Fatal("want an error")
	}
	for _, jql := range jqls {
		if !strings.Contains(jql, "PAY-1") || !strings.Contains(jql, "PAY-2") {
			t.Fatalf("a rate limit shrank the batch: %q", jql)
		}
	}
	if len(jqls) != maxAttempts {
		t.Fatalf("attempts = %d, want %d", len(jqls), maxAttempts)
	}
}

func TestSearchDoesNotWaitOutRateLimits(t *testing.T) {
	var requests int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Retry-After", "30")
		writeJiraError(w, http.StatusTooManyRequests, "Rate limit exceeded.")
	}))
	defer ts.Close()
	c, err := New(Config{BaseURL: ts.URL})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := c.Search(context.Background(), "project = PAY", "", 50); err == nil {
		t.Fatal("want an error")
	}
	if requests != 1 {
		t.Fatalf("search made %d requests, want one and out", requests)
	}
}

func TestRetryAfterHeaderForms(t *testing.T) {
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		raw  string
		want time.Duration
		ok   bool
	}{
		{"30", 30 * time.Second, true},
		{"  5 ", 5 * time.Second, true},
		{"0", 0, true},
		{"-1", 0, false},
		{"soon", 0, false},
		{"", 0, false},
		{"9223372037", time.Duration(math.MaxInt64), true},
		{"99999999999999", time.Duration(math.MaxInt64), true},
	} {
		got, ok := retryAfterHeader(c.raw, now)
		if ok != c.ok || (ok && got != c.want) {
			t.Fatalf("retryAfterHeader(%q) = %v, %v; want %v, %v", c.raw, got, ok, c.want, c.ok)
		}
	}

	future := now.Add(20 * time.Second).Format(http.TimeFormat)
	got, ok := retryAfterHeader(future, now)
	if !ok || got != 20*time.Second {
		t.Fatalf("retryAfterHeader(%q) = %v, %v", future, got, ok)
	}

	past := now.Add(-time.Hour).Format(http.TimeFormat)
	if got, ok := retryAfterHeader(past, now); !ok || got != 0 {
		t.Fatalf("retryAfterHeader(%q) = %v, %v", past, got, ok)
	}
}

// A date-form Retry-After further out than the fetcher may wait stops it,
// rather than being ignored and retried in 500ms.
func TestBackoffRespectsADistantRetryAfterDate(t *testing.T) {
	var requests int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Retry-After", time.Now().Add(time.Hour).UTC().Format(http.TimeFormat))
		writeJiraError(w, http.StatusTooManyRequests, "Rate limit exceeded.")
	}))
	defer ts.Close()
	c, err := New(Config{BaseURL: ts.URL})
	if err != nil {
		t.Fatal(err)
	}
	c.wait = func(context.Context, time.Duration) error {
		t.Fatal("wait called for a delay outside the retry budget")
		return nil
	}
	if _, err := c.FetchIssues(context.Background(), []string{"PAY-1"}, nil); err == nil {
		t.Fatal("want an error")
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want one and out", requests)
	}
}

// A Retry-After too large to represent must not become an immediate retry:
// multiplying it out wraps, and a negative delay fires the timer at once —
// hammering a deployment that asked for the opposite.
func TestHugeRetryAfterDoesNotRetryImmediately(t *testing.T) {
	var requests int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Retry-After", "9223372037")
		writeJiraError(w, http.StatusTooManyRequests, "Rate limit exceeded.")
	}))
	defer ts.Close()
	c, err := New(Config{BaseURL: ts.URL})
	if err != nil {
		t.Fatal(err)
	}
	c.wait = func(context.Context, time.Duration) error {
		t.Fatal("wait called for an unrepresentable delay")
		return nil
	}
	if _, err := c.FetchIssues(context.Background(), []string{"PAY-1"}, nil); err == nil {
		t.Fatal("want an error")
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want one and out", requests)
	}
}

func TestBackoffDoesNotSleepAfterTheLastAttempt(t *testing.T) {
	var requests int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		writeJiraError(w, http.StatusTooManyRequests, "Rate limit exceeded.")
	}))
	defer ts.Close()
	c, err := New(Config{BaseURL: ts.URL})
	if err != nil {
		t.Fatal(err)
	}
	var waits []time.Duration
	c.wait = func(_ context.Context, delay time.Duration) error {
		waits = append(waits, delay)
		return nil
	}

	_, err = c.FetchIssues(context.Background(), []string{"PAY-1"}, nil)
	if err == nil {
		t.Fatal("want an error")
	}
	if requests != maxAttempts {
		t.Fatalf("requests = %d, want %d", requests, maxAttempts)
	}
	want := []time.Duration{baseRetryDelay, 2 * baseRetryDelay, 4 * baseRetryDelay}
	if !reflect.DeepEqual(waits, want) {
		t.Fatalf("waits = %v, want %v", waits, want)
	}
}

func TestRetryWaitBudgetSpansSalvageRounds(t *testing.T) {
	requests := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		switch requests {
		case 1, 3:
			w.Header().Set("Retry-After", "20")
			writeJiraError(w, http.StatusTooManyRequests, "Rate limit exceeded.")
		case 2:
			writeJiraError(w, http.StatusBadRequest,
				"An issue with key 'PAY-1' does not exist for field 'key'.")
		}
	}))
	defer ts.Close()
	c, err := New(Config{BaseURL: ts.URL})
	if err != nil {
		t.Fatal(err)
	}
	var waits []time.Duration
	c.wait = func(_ context.Context, delay time.Duration) error {
		waits = append(waits, delay)
		return nil
	}

	if _, err := c.FetchIssues(context.Background(), []string{"PAY-1", "PAY-2"}, nil); err == nil {
		t.Fatal("want the second 20-second wait to exceed the remaining budget")
	}
	if requests != 3 {
		t.Fatalf("requests = %d, want 3", requests)
	}
	if want := []time.Duration{20 * time.Second}; !reflect.DeepEqual(waits, want) {
		t.Fatalf("waits = %v, want %v", waits, want)
	}
}
