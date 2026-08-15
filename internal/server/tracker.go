package server

import (
	"errors"
	"fmt"
	"log"
	"net/http"

	"github.com/dnswlt/roadie/internal/tracker"
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
