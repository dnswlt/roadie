package server

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"

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

// The schedule-check extractor script (notes/schedule_check.md). Same route
// shape and same reasoning as the saved queries above — guard, not snap — and
// likewise independent of s.tracker: a script is editable while the connection
// is down. Roadmap-scoped rather than deployment-wide, unlike search, because
// the script belongs to a roadmap.

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

// putTrackerExtractor validates before storing: the script is compiled, its top
// level executed and its well-known names checked, so a script that cannot run
// is never saved. That check needs the interpreter and is semantic, which is
// why it lives here rather than in the store — JQL validity sits the same way.
// Every failure extractor.Compile reports is the author's to fix, so all of
// them are a 400 carrying Starlark's own wording and line.
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

// The schedule check (notes/schedule_check.md): are the issues linked from an
// item still scheduled inside that item's time range?
//
// Two routes and no work. internal/recon's one goroutine makes every tracker
// request, so enqueueing appends to its queue and polling reads its cache;
// neither reaches Jira, and neither does work proportional to the keys it is
// given, which is why there is no cap on how many a request may name.
//
// Link parsing (links.ts, recon-diff.ts) and the comparison stay in the
// frontend, which is where the items are.

type scheduleCheckRequest struct {
	Keys []string `json:"keys"`
}

// enqueueScheduleCheck hands keys to the fetcher and returns at once, reporting
// how many it took. Fewer than were sent means its queue is full; the rest stay
// unchecked and the caller may ask again.
func (s *Server) enqueueScheduleCheck(w http.ResponseWriter, r *http.Request) {
	id, req, ok := s.readScheduleCheck(w, r)
	if !ok {
		return
	}
	queued := s.recon.Enqueue(id, distinctKeys(req.Keys))
	writeJSON(w, http.StatusAccepted, map[string]int{"queued": queued})
}

// scheduleCheckStatus answers for exactly the keys asked about, from what the
// fetcher has established so far. Anything else reads as unchecked.
func (s *Server) scheduleCheckStatus(w http.ResponseWriter, r *http.Request) {
	id, req, ok := s.readScheduleCheck(w, r)
	if !ok {
		return
	}
	// A roadmap with no script is a 404, the state the Recon tab explains and
	// offers to fix; the store's error carries that through writeErr.
	status, err := s.recon.Status(r.Context(), id, distinctKeys(req.Keys))
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// readScheduleCheck is the part both routes share: the roadmap, the key list,
// and the check that reconciliation is configured at all. It writes the
// response itself when it returns false.
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

// distinctKeys drops blanks and repeats, comparing case-insensitively because
// Jira keys do, so one key is one row in a status response.
func distinctKeys(keys []string) []string {
	seen := make(map[string]bool, len(keys))
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" || seen[strings.ToUpper(key)] {
			continue
		}
		seen[strings.ToUpper(key)] = true
		out = append(out, key)
	}
	return out
}
