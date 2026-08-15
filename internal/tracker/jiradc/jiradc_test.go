package jiradc

import (
	"context"
	"encoding/json"
	"errors"
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
