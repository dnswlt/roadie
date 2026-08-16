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
	if got.Key != "PAY-2" || got.Fields.Status.Name != "In Progress" {
		t.Fatalf("unexpected issue: %+v", got)
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
