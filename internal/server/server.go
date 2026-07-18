// Package server exposes the roadmap store as a JSON/REST API and serves
// the static frontend.
package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"strconv"

	"github.com/dnswlt/roadie/internal/store"
)

type Server struct {
	store *store.Store
	mux   *http.ServeMux
}

func New(st *store.Store, static fs.FS) *Server {
	s := &Server{store: st, mux: http.NewServeMux()}

	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	s.mux.HandleFunc("GET /api/roadmaps", s.listRoadmaps)
	s.mux.HandleFunc("POST /api/roadmaps", s.createRoadmap)
	s.mux.HandleFunc("GET /api/roadmaps/{id}", s.getRoadmap)
	s.mux.HandleFunc("PATCH /api/roadmaps/{id}", s.patchRoadmap)
	s.mux.HandleFunc("DELETE /api/roadmaps/{id}", s.deleteRoadmap)
	s.mux.HandleFunc("POST /api/roadmaps/{id}/lanes", s.createLane)
	s.mux.HandleFunc("PUT /api/roadmaps/{id}/lane-order", s.reorderLanes)
	s.mux.HandleFunc("PATCH /api/lanes/{id}", s.patchLane)
	s.mux.HandleFunc("DELETE /api/lanes/{id}", s.deleteLane)
	s.mux.HandleFunc("POST /api/lanes/{id}/items", s.createItem)
	s.mux.HandleFunc("PATCH /api/items/{id}", s.patchItem)
	s.mux.HandleFunc("DELETE /api/items/{id}", s.deleteItem)

	s.mux.Handle("/", http.FileServerFS(static))
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

// Helpers

func pathID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid id %q", r.PathValue("id"))
	}
	return id, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write response: %v", err)
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("invalid request body: %w", err)
	}
	return nil
}

// writeErr maps store errors to HTTP statuses. Errors from readJSON/pathID
// are passed with an explicit 400 via writeClientErr.
func (s *Server) writeErr(w http.ResponseWriter, err error) {
	var ve *store.ValidationError
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	case errors.As(err, &ve):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": ve.Msg})
	default:
		log.Printf("internal error: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	}
}

func writeClientErr(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
}

// Roadmaps

func (s *Server) listRoadmaps(w http.ResponseWriter, r *http.Request) {
	roadmaps, err := s.store.ListRoadmaps(r.Context())
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, roadmaps)
}

type nameReq struct {
	Name string `json:"name"`
}

func (s *Server) createRoadmap(w http.ResponseWriter, r *http.Request) {
	var req nameReq
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	rm, err := s.store.CreateRoadmap(r.Context(), req.Name)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, rm)
}

func (s *Server) getRoadmap(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	full, err := s.store.GetRoadmapFull(r.Context(), id)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, full)
}

func (s *Server) patchRoadmap(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var req nameReq
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	rm, err := s.store.RenameRoadmap(r.Context(), id, req.Name)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rm)
}

func (s *Server) deleteRoadmap(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	if err := s.store.DeleteRoadmap(r.Context(), id); err != nil {
		s.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Lanes

func (s *Server) createLane(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var req nameReq
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	lane, err := s.store.CreateLane(r.Context(), id, req.Name)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, lane)
}

func (s *Server) reorderLanes(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var req struct {
		LaneIDs []int64 `json:"laneIds"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	if err := s.store.ReorderLanes(r.Context(), id, req.LaneIDs); err != nil {
		s.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) patchLane(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var patch store.LanePatch
	if err := readJSON(w, r, &patch); err != nil {
		writeClientErr(w, err)
		return
	}
	lane, err := s.store.UpdateLane(r.Context(), id, patch)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lane)
}

func (s *Server) deleteLane(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	if err := s.store.DeleteLane(r.Context(), id); err != nil {
		s.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Items

func (s *Server) createItem(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var req store.NewItem
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	item, err := s.store.CreateItem(r.Context(), id, req)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) patchItem(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var patch store.ItemPatch
	if err := readJSON(w, r, &patch); err != nil {
		writeClientErr(w, err)
		return
	}
	item, err := s.store.UpdateItem(r.Context(), id, patch)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) deleteItem(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	if err := s.store.DeleteItem(r.Context(), id); err != nil {
		s.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
