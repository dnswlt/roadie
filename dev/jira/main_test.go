package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

var testIssues = []fixtureIssue{
	{Key: "PAY-1", Summary: "First payment provider", IssueType: "Epic", Status: "To Do"},
	{Key: "PAY-2", Summary: "Second PAYMENT provider", IssueType: "Story", Status: "In Progress"},
	{Key: "PAY-3", Summary: "Third account flow", IssueType: "Task", Status: "Done"},
}

func TestSearchFiltersTitleAndPages(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/rest/api/2/search", strings.NewReader(
		`{"jql":"payment PROVIDER","startAt":1,"maxResults":1,"fields":["summary"]}`,
	))
	req.Host = "jira.test"
	w := httptest.NewRecorder()
	newHandler(testIssues).ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var got struct {
		StartAt int         `json:"startAt"`
		Total   int         `json:"total"`
		Issues  []jiraIssue `json:"issues"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.StartAt != 1 || got.Total != 2 || len(got.Issues) != 1 || got.Issues[0].Key != "PAY-2" {
		t.Fatalf("unexpected response: %+v", got)
	}
	// The id remains its fixture position rather than its position in this
	// filtered result, just as it does across pages of a real Jira search.
	if got.Issues[0].ID != "2" {
		t.Fatalf("issue id = %q, want stable fixture id 2", got.Issues[0].ID)
	}
}

func TestSearchEmptyQueryMatchesAllIssues(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/rest/api/2/search", strings.NewReader(
		`{"jql":"  ","startAt":0,"maxResults":50}`,
	))
	w := httptest.NewRecorder()
	newHandler(testIssues).ServeHTTP(w, req)

	var got struct {
		Total  int         `json:"total"`
		Issues []jiraIssue `json:"issues"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || got.Total != 3 || len(got.Issues) != 3 {
		t.Fatalf("status = %d, response = %+v", w.Code, got)
	}
}

func TestSearchRequiresEveryTerm(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/rest/api/2/search", strings.NewReader(
		`{"jql":"payment account","startAt":0,"maxResults":50}`,
	))
	w := httptest.NewRecorder()
	newHandler(testIssues).ServeHTTP(w, req)

	var got struct {
		Total  int         `json:"total"`
		Issues []jiraIssue `json:"issues"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || got.Total != 0 || len(got.Issues) != 0 {
		t.Fatalf("status = %d, response = %+v", w.Code, got)
	}
}

func TestGetIssue(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/rest/api/2/issue/pay-2", nil)
	w := httptest.NewRecorder()
	newHandler(testIssues).ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var got jiraIssue
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Key != "PAY-2" || fieldName(got.Fields, "status") != "In Progress" {
		t.Fatalf("unexpected issue: %+v", got)
	}
}

// fieldName reads fields[name].name out of decoded JSON, Jira's shape for a
// status or an issue type.
func fieldName(fields map[string]any, name string) string {
	nested, _ := fields[name].(map[string]any)
	s, _ := nested["name"].(string)
	return s
}

// The by-key fetch behind the schedule check, including the whole-query
// rejection that makes Roadie fall back to one request per key.
func TestSearchByKey(t *testing.T) {
	issues := []fixtureIssue{
		{Key: "PAY-1", Summary: "First", IssueType: "Epic", Status: "To Do",
			Fields: map[string]any{"duedate": "2026-04-12"}},
		{Key: "PAY-2", Summary: "Second", IssueType: "Story", Status: "Done"},
	}

	post := func(jql string, fields []string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(searchRequest{JQL: jql, MaxResults: 10, Fields: fields})
		req := httptest.NewRequest(http.MethodPost, "/rest/api/2/search", strings.NewReader(string(body)))
		w := httptest.NewRecorder()
		newHandler(issues).ServeHTTP(w, req)
		return w
	}

	w := post(`key in ("PAY-1", "PAY-2")`, []string{"summary", "issuetype", "status", "duedate"})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	// Decoded fresh each time: unmarshalling into a reused map merges into it,
	// which would hide exactly the field selection asserted below.
	decodeIssues := func(w *httptest.ResponseRecorder) []jiraIssue {
		t.Helper()
		var got struct {
			Issues []jiraIssue `json:"issues"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got.Issues
	}

	found := decodeIssues(w)
	if len(found) != 2 {
		t.Fatalf("issues = %+v", found)
	}
	if found[0].Fields["duedate"] != "2026-04-12" {
		t.Fatalf("extra fields dropped: %+v", found[0].Fields)
	}

	// Field selection is honoured, or a script could read a field nobody asked
	// Jira for and only discover that in production.
	found = decodeIssues(post(`key in ("PAY-1")`, []string{"summary", "issuetype", "status"}))
	if _, present := found[0].Fields["duedate"]; present {
		t.Fatalf("unrequested field returned: %+v", found[0].Fields)
	}

	// One unknown key rejects the whole query, as Jira does — and every
	// unknown key is named, which is what Roadie's salvage reads.
	w = post(`key in ("PAY-1", "NOPE-8", "NOPE-9")`, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown key: status = %d, body = %s", w.Code, w.Body.String())
	}
	var rejection struct {
		ErrorMessages []string `json:"errorMessages"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &rejection); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(rejection.ErrorMessages, " ")
	if !strings.Contains(joined, "'NOPE-8'") || !strings.Contains(joined, "'NOPE-9'") {
		t.Fatalf("not every unknown key was named: %q", joined)
	}
	if strings.Contains(joined, "'PAY-1'") {
		t.Fatalf("a key that exists was named: %q", joined)
	}
}

func TestGetMissingIssue(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/rest/api/2/issue/NOPE-1", nil)
	w := httptest.NewRecorder()
	newHandler(testIssues).ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
}
