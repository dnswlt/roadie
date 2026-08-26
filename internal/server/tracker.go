package server

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/dnswlt/roadie/internal/recon"
	"github.com/dnswlt/roadie/internal/store"
	"github.com/dnswlt/roadie/internal/tracker"
	"github.com/dnswlt/roadie/internal/tracker/extractor"
)

const (
	defaultTrackerPageSize = 100
	maxTrackerPageSize     = 100
)

type trackerSearchRequest struct {
	Query        string `json:"query"`
	Continuation string `json:"continuation,omitempty"`
	PageSize     int    `json:"pageSize,omitempty"`
}

// searchTracker exposes the deployment's read-only tracker connection. It is
// deliberately not roadmap-scoped: neither the query nor its result contains
// Roadie data, and the frontend reconciles it against the open roadmap.
func (s *Server) searchTracker(w http.ResponseWriter, r *http.Request) {
	if s.tracker == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "issue tracker is not configured"})
		return
	}

	var req trackerSearchRequest
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	if req.PageSize == 0 {
		req.PageSize = defaultTrackerPageSize
	}
	if req.PageSize < 1 || req.PageSize > maxTrackerPageSize {
		writeClientErr(w, fmt.Errorf("pageSize must be between 1 and 100"))
		return
	}

	page, err := s.tracker.Search(r.Context(), req.Query, req.Continuation, req.PageSize)
	if err != nil {
		// A query the tracker rejected and explained is the user's to fix, so
		// its wording reaches the browser like a store.ValidationError does.
		// Anything else is the deployment's problem: it stays a 502 whose
		// detail is for the log, not for whoever typed the query.
		var qErr *tracker.QueryError
		if errors.As(err, &qErr) {
			writeClientErr(w, qErr)
			return
		}
		log.Printf("tracker search: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "issue tracker query failed"})
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// Saved tracker queries ("favourites", notes/JIRA.md). Roadmap-scoped
// operational data with visibility's route shape: guard rather than snap —
// not roadmap content, so no pre-mutation snapshot, no SSE broadcast, no
// contributor attribution. Deliberately independent of s.tracker: favourites
// outlive a temporarily unconfigured connection.

type trackerQueryRequest struct {
	Name  string `json:"name"`
	Query string `json:"query"`
}

// byTrackerQueryID resolves a saved query to its roadmap for the access guard.
func byTrackerQueryID(s *Server, r *http.Request) (int64, error) {
	id, err := pathID(r)
	if err != nil {
		return 0, err
	}
	return s.store.RoadmapIDByTrackerQuery(r.Context(), id)
}

func (s *Server) listTrackerQueries(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	queries, err := s.store.ListTrackerQueries(r.Context(), id)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, queries)
}

func (s *Server) createTrackerQuery(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var req trackerQueryRequest
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	q, err := s.store.CreateTrackerQuery(r.Context(), id, req.Name, req.Query)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, q)
}

func (s *Server) patchTrackerQuery(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var patch store.TrackerQueryPatch
	if err := readJSON(w, r, &patch); err != nil {
		writeClientErr(w, err)
		return
	}
	q, err := s.store.UpdateTrackerQuery(r.Context(), id, patch)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, q)
}

func (s *Server) deleteTrackerQuery(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	if err := s.store.DeleteTrackerQuery(r.Context(), id); err != nil {
		s.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Extractor scripts are operational data: guarded, but not snapshotted.

type trackerExtractorRequest struct {
	Source string `json:"source"`
}

func (s *Server) getTrackerExtractor(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	e, err := s.store.GetTrackerExtractor(r.Context(), id)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, e)
}

// putTrackerExtractor validates the script before storing it.
func (s *Server) putTrackerExtractor(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var req trackerExtractorRequest
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	if _, err := extractor.Compile(req.Source); err != nil {
		writeClientErr(w, err)
		return
	}
	e, err := s.store.PutTrackerExtractor(r.Context(), id, req.Source)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, e)
}

// trackerExtractorTestRequest carries the *editor's* source, not the stored
// one: Test is how a script is arrived at, so it has to run before Save would
// accept it.
type trackerExtractorTestRequest struct {
	Source string `json:"source"`
	Key    string `json:"key"`
}

// trackerExtractorTestResponse is one issue put through one script. State uses
// the check's own vocabulary, so the editor and the results list describe an
// outcome the same way.
type trackerExtractorTestResponse struct {
	State string         `json:"state"`
	Issue *tracker.Issue `json:"issue,omitempty"`
	// Fields is what the script declared, which is not what was fetched: the
	// adapter adds the display fields. Shown so a script that names nothing
	// still explains why Raw holds only summary, issuetype and status.
	Fields []string `json:"fields"`
	// Raw is exactly the argument the script received — the tracker's own JSON,
	// named as the tracker names it. This route is the only one that serializes
	// it, and it does so because discovering that Begin Date is
	// customfield_10430 in *this* deployment is impossible without it.
	Raw         map[string]any `json:"raw,omitempty"`
	Start       string         `json:"start,omitempty"`
	End         string         `json:"end,omitempty"`
	StartPeriod string         `json:"startPeriod,omitempty"`
	EndPeriod   string         `json:"endPeriod,omitempty"`
	Label       string         `json:"label,omitempty"`
	Error       string         `json:"error,omitempty"`
	Output      []string       `json:"output,omitempty"`
}

// testTrackerExtractor runs the unsaved source against one named key.
//
// It fetches directly rather than through internal/recon's goroutine, and that
// is not a hole in "one goroutine talks to the tracker": that rule is about the
// check, whose queue and cache are both keyed by a *saved* script. This is one
// issue on one deliberate click, the same posture as the interactive search —
// and routing it through the fetcher would make the editor wait behind whatever
// roadmap is being checked, to answer about a script the queue cannot key.
//
// A script that does not compile is a 400, exactly as saving one is. Everything
// past that point is a result to render, not a failed request: a raising script,
// a key nobody can see, a range that comes back empty are all things the author
// is here to look at.
func (s *Server) testTrackerExtractor(w http.ResponseWriter, r *http.Request) {
	if _, err := pathID(r); err != nil {
		writeClientErr(w, err)
		return
	}
	if s.tracker == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "issue tracker is not configured"})
		return
	}
	var req trackerExtractorTestRequest
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	key := uppercaseIssueKey(req.Key)
	if key == "" {
		writeClientErr(w, fmt.Errorf("name an issue to test against"))
		return
	}
	script, err := extractor.Compile(req.Source)
	if err != nil {
		writeClientErr(w, err)
		return
	}

	resp := trackerExtractorTestResponse{Fields: script.Fields(), Output: script.Output()}
	if resp.Fields == nil {
		resp.Fields = []string{}
	}
	issues, err := s.tracker.FetchIssues(r.Context(), []string{key}, script.Fields())
	if err != nil {
		// Same rule as the search route: a request the tracker rejected and
		// explained is the user's to fix — a field id that does not exist here
		// is precisely that — and anything else stays a 502 with its detail in
		// the log.
		var qErr *tracker.QueryError
		if errors.As(err, &qErr) {
			writeClientErr(w, qErr)
			return
		}
		log.Printf("tracker extractor test: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "issue tracker query failed"})
		return
	}
	if len(issues) == 0 {
		resp.State = recon.StateNotFound
		writeJSON(w, http.StatusOK, resp)
		return
	}

	issue := issues[0]
	resp.Issue, resp.Raw = &issue.Issue, issue.Raw
	res, err := script.TimeRange(issue.Raw)
	// Whatever the call printed comes back either way; a failing script's
	// prints are the ones most worth reading.
	resp.Output = append(resp.Output, res.Output...)
	switch {
	case err != nil:
		resp.State, resp.Error = recon.StateError, err.Error()
	case res.Skip:
		resp.State = recon.StateSkipped
	default:
		resp.State = recon.StateOK
		resp.Start, resp.End = res.Start, res.End
		resp.StartPeriod, resp.EndPeriod = res.StartPeriod, res.EndPeriod
		resp.Label = res.Label
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) deleteTrackerExtractor(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	if err := s.store.DeleteTrackerExtractor(r.Context(), id); err != nil {
		s.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type scheduleCheckRequest struct {
	Keys []string `json:"keys"`
}

// enqueueScheduleCheck reports how many distinct keys the queue covers. A
// short count means the queue is full.
func (s *Server) enqueueScheduleCheck(w http.ResponseWriter, r *http.Request) {
	id, req, ok := s.readScheduleCheck(w, r)
	if !ok {
		return
	}
	queued := s.recon.Enqueue(id, distinctKeys(req.Keys))
	writeJSON(w, http.StatusAccepted, map[string]int{"queued": queued})
}

// scheduleCheckStatus returns cached results without enqueuing work.
func (s *Server) scheduleCheckStatus(w http.ResponseWriter, r *http.Request) {
	id, req, ok := s.readScheduleCheck(w, r)
	if !ok {
		return
	}
	status, err := s.recon.Status(r.Context(), id, distinctKeys(req.Keys))
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) readScheduleCheck(w http.ResponseWriter, r *http.Request) (int64, scheduleCheckRequest, bool) {
	var req scheduleCheckRequest
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return 0, req, false
	}
	if s.recon == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "issue tracker is not configured"})
		return 0, req, false
	}
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return 0, req, false
	}
	return id, req, true
}

// distinctKeys uppercases and deduplicates Jira keys at the HTTP boundary.
func distinctKeys(keys []string) []string {
	seen := make(map[string]bool, len(keys))
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		key = uppercaseIssueKey(key)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, key)
	}
	return out
}

func uppercaseIssueKey(key string) string {
	return strings.ToUpper(key)
}
