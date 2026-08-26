// Jira is a tiny, read-only Jira Data Center stand-in for local development.
// It implements the two REST resources and JQL forms Roadie uses.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"maps"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
)

type fixtureIssue struct {
	Key       string `json:"key"`
	Summary   string `json:"summary"`
	IssueType string `json:"issueType"`
	Status    string `json:"status"`
	// Fields cannot override the display fields above.
	Fields map[string]any `json:"fields,omitempty"`
}

type searchRequest struct {
	JQL        string   `json:"jql"`
	StartAt    int      `json:"startAt"`
	MaxResults int      `json:"maxResults"`
	Fields     []string `json:"fields"`
}

type jiraIssue struct {
	ID     string         `json:"id"`
	Key    string         `json:"key"`
	Self   string         `json:"self"`
	Fields map[string]any `json:"fields"`
}

type server struct {
	issues []fixtureIssue
}

func main() {
	addr := flag.String("addr", "localhost:4012", "listen address")
	issuesPath := flag.String("issues", "issues.json", "fixture JSON file")
	flag.Parse()

	issues, err := loadIssues(*issuesPath)
	if err != nil {
		log.Fatal(err)
	}

	log.Printf("mock Jira Data Center listening at http://%s (%d issues)", *addr, len(issues))
	if err := http.ListenAndServe(*addr, newHandler(issues)); err != nil {
		log.Fatal(err)
	}
}

func loadIssues(path string) ([]fixtureIssue, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read issues: %w", err)
	}
	var issues []fixtureIssue
	if err := json.Unmarshal(b, &issues); err != nil {
		return nil, fmt.Errorf("decode issues: %w", err)
	}
	seen := make(map[string]bool, len(issues))
	for i, issue := range issues {
		key := strings.ToUpper(strings.TrimSpace(issue.Key))
		if key == "" || issue.Summary == "" || issue.IssueType == "" || issue.Status == "" {
			return nil, fmt.Errorf("issue %d must have key, summary, issueType, and status", i)
		}
		if seen[key] {
			return nil, fmt.Errorf("duplicate issue key %q", key)
		}
		seen[key] = true
		issues[i].Key = key
	}
	return issues, nil
}

func newHandler(issues []fixtureIssue) http.Handler {
	s := &server{issues: issues}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /rest/api/2/search", s.search)
	mux.HandleFunc("GET /rest/api/2/issue/{key}", s.getIssue)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

func (s *server) search(w http.ResponseWriter, r *http.Request) {
	var req searchRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid search request")
		return
	}
	if req.StartAt < 0 || req.MaxResults < 0 {
		writeError(w, http.StatusBadRequest, "startAt and maxResults must not be negative")
		return
	}
	if req.MaxResults == 0 {
		req.MaxResults = 50
	}

	matches := matchingIssueIndices(s.issues, req.JQL)
	if keys, ok := keysFromJQL(req.JQL); ok {
		matches = nil
		for i, issue := range s.issues {
			if keys[issue.Key] {
				matches = append(matches, i)
			}
		}
		// Jira rejects the whole query and names each unknown key.
		if len(matches) != len(keys) {
			found := map[string]bool{}
			for _, i := range matches {
				found[s.issues[i].Key] = true
			}
			var missing []string
			for _, key := range slices.Sorted(maps.Keys(keys)) {
				if !found[key] {
					missing = append(missing, fmt.Sprintf("An issue with key '%s' does not exist for field 'key'.", key))
				}
			}
			writeJSON(w, http.StatusBadRequest,
				map[string]any{"errorMessages": missing, "errors": map[string]string{}})
			return
		}
	}
	start := min(req.StartAt, len(matches))
	end := min(start+req.MaxResults, len(matches))
	page := make([]jiraIssue, 0, end-start)
	for i := start; i < end; i++ {
		fixtureIndex := matches[i]
		page = append(page, toJiraIssue(r, fixtureIndex+1, s.issues[fixtureIndex], req.Fields))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"startAt":    start,
		"maxResults": req.MaxResults,
		"total":      len(matches),
		"issues":     page,
	})
}

// matchingIssueIndices implements the mock's summary search.
func matchingIssueIndices(issues []fixtureIssue, query string) []int {
	terms := strings.Fields(strings.ToLower(query))
	matches := make([]int, 0, len(issues))
	for i, issue := range issues {
		summary := strings.ToLower(issue.Summary)
		matched := true
		for _, term := range terms {
			if !strings.Contains(summary, term) {
				matched = false
				break
			}
		}
		if matched {
			matches = append(matches, i)
		}
	}
	return matches
}

func (s *server) getIssue(w http.ResponseWriter, r *http.Request) {
	key := strings.ToUpper(r.PathValue("key"))
	for i, issue := range s.issues {
		if issue.Key == key {
			writeJSON(w, http.StatusOK, toJiraIssue(r, i+1, issue, splitFields(r.URL.Query().Get("fields"))))
			return
		}
	}
	writeError(w, http.StatusNotFound, "Issue does not exist or you do not have permission to see it.")
}

// keysFromJQL recognizes `key in ("A", "B")` queries.
func keysFromJQL(jql string) (map[string]bool, bool) {
	jql = strings.TrimSpace(jql)
	rest, ok := strings.CutPrefix(strings.ToLower(jql), "key in (")
	if !ok || !strings.HasSuffix(rest, ")") {
		return nil, false
	}
	keys := map[string]bool{}
	for _, part := range strings.Split(strings.TrimSuffix(jql[len("key in ("):], ")"), ",") {
		if key := strings.ToUpper(strings.Trim(strings.TrimSpace(part), `"'`)); key != "" {
			keys[key] = true
		}
	}
	return keys, len(keys) > 0
}

func splitFields(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	return strings.Split(raw, ",")
}

// toJiraIssue applies Jira's field selection to a fixture issue.
func toJiraIssue(r *http.Request, id int, issue fixtureIssue, fields []string) jiraIssue {
	all := map[string]any{
		"summary":   issue.Summary,
		"issuetype": map[string]any{"name": issue.IssueType},
		"status":    map[string]any{"name": issue.Status},
	}
	for name, value := range issue.Fields {
		if _, reserved := all[name]; !reserved {
			all[name] = value
		}
	}
	selected := all
	if len(fields) > 0 {
		selected = map[string]any{}
		for _, name := range fields {
			name = strings.TrimSpace(name)
			if value, ok := all[name]; ok {
				selected[name] = value
			}
		}
	}
	return jiraIssue{
		ID:     strconv.Itoa(id),
		Key:    issue.Key,
		Self:   "http://" + r.Host + "/rest/api/2/issue/" + issue.Key,
		Fields: selected,
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"errorMessages": []string{message}, "errors": map[string]string{}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
