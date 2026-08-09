package server

import (
	"net/http"

	"github.com/dnswlt/roadie/internal/model"
)

// Dependency endpoints. There is no GET: edges ride in the RoadmapFull
// payload, so reads come for free with the roadmap itself.

func byDependencyID(s *Server, r *http.Request) (int64, error) {
	id, err := pathID(r)
	if err != nil {
		return 0, err
	}
	return s.store.RoadmapIDByDependency(r.Context(), id)
}

// newDependencyReq is createDependency's body: the edge's two endpoints,
// from = prerequisite, to = dependent ("to needs from").
type newDependencyReq struct {
	From model.DependencyRef `json:"from"`
	To   model.DependencyRef `json:"to"`
}

func (s *Server) createDependency(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var req newDependencyReq
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	d, err := s.store.CreateDependency(r.Context(), id, req.From, req.To)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, d)
}

func (s *Server) deleteDependency(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	if err := s.store.DeleteDependency(r.Context(), id); err != nil {
		s.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
