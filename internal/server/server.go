// Package server exposes the roadmap store as a JSON/REST API and serves
// the static frontend.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dnswlt/roadie/internal/model"
	"github.com/dnswlt/roadie/internal/store"
)

type Server struct {
	store *store.Store
	mux   *http.ServeMux

	// lastAuto records when each roadmap was last auto-snapshotted, so the
	// capture throttle (autoSnapshot) is an in-process check rather than a DB
	// round-trip — and, by claiming the window before capturing, collapses a
	// burst of concurrent mutations into one snapshot. See autoSnapshot.
	snapMu   sync.Mutex
	lastAuto map[int64]time.Time
}

func New(st *store.Store, static fs.FS) *Server {
	s := &Server{store: st, mux: http.NewServeMux(), lastAuto: map[int64]time.Time{}}

	// Liveness: the process is up. Deliberately does not touch the database —
	// a DB blip shouldn't get healthy pods killed and restarted.
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	// Readiness: the pod can actually serve traffic, which here means the
	// database is reachable. k8s stops routing to a pod that fails this.
	s.mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.store.Ping(ctx); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})

	s.mux.HandleFunc("GET /api/roadmaps", s.listRoadmaps)
	s.mux.HandleFunc("POST /api/roadmaps", s.createRoadmap)
	s.mux.HandleFunc("POST /api/roadmaps/import", s.importRoadmap)
	s.mux.HandleFunc("POST /api/roadmaps/{id}/duplicate", s.duplicateRoadmap)
	s.mux.HandleFunc("GET /api/roadmaps/{id}/export", s.exportRoadmap)
	s.mux.HandleFunc("GET /api/roadmaps/{id}", s.getRoadmap)
	s.mux.HandleFunc("PATCH /api/roadmaps/{id}", s.snap(snapThrottle, byRoadmapID, s.patchRoadmap))
	// No auto snapshot on roadmap delete: the FK cascade removes its snapshots too.
	s.mux.HandleFunc("DELETE /api/roadmaps/{id}", s.deleteRoadmap)
	s.mux.HandleFunc("POST /api/roadmaps/{id}/lanes", s.snap(snapThrottle, byRoadmapID, s.createLane))
	s.mux.HandleFunc("PUT /api/roadmaps/{id}/lane-order", s.snap(snapThrottle, byRoadmapID, s.reorderLanes))
	s.mux.HandleFunc("PATCH /api/lanes/{id}", s.snap(snapThrottle, byLaneID, s.patchLane))
	s.mux.HandleFunc("DELETE /api/lanes/{id}", s.snap(snapForce, byLaneID, s.deleteLane))
	s.mux.HandleFunc("POST /api/lanes/{id}/items", s.snap(snapThrottle, byLaneID, s.createItem))
	s.mux.HandleFunc("PATCH /api/items/{id}", s.snap(snapThrottle, byItemID, s.patchItem))
	s.mux.HandleFunc("DELETE /api/items/{id}", s.snap(snapForce, byItemID, s.deleteItem))
	s.mux.HandleFunc("POST /api/lanes/{id}/milestones", s.snap(snapThrottle, byLaneID, s.createMilestone))
	s.mux.HandleFunc("PATCH /api/milestones/{id}", s.snap(snapThrottle, byMilestoneID, s.patchMilestone))
	s.mux.HandleFunc("DELETE /api/milestones/{id}", s.snap(snapForce, byMilestoneID, s.deleteMilestone))

	// Snapshots (version history). Restore captures the pre-restore state in the
	// store, so it is deliberately not wrapped with s.snap.
	s.mux.HandleFunc("GET /api/roadmaps/{id}/snapshots", s.listSnapshots)
	s.mux.HandleFunc("GET /api/snapshots/{id}", s.getSnapshot)
	s.mux.HandleFunc("POST /api/snapshots/{id}/restore", s.restoreSnapshot)
	s.mux.HandleFunc("DELETE /api/snapshots/{id}", s.deleteSnapshot)

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

// duplicateRoadmap deep-copies a roadmap. An omitted or empty name reuses the
// source's, which the store disambiguates with a " (n)" suffix.
func (s *Server) duplicateRoadmap(w http.ResponseWriter, r *http.Request) {
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
	rm, err := s.store.DuplicateRoadmap(r.Context(), id, req.Name)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, rm)
}

// exportRoadmap streams the roadmap as a downloadable JSON file (the
// RoadmapExport envelope), named after the roadmap.
func (s *Server) exportRoadmap(w http.ResponseWriter, r *http.Request) {
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
	exp := model.RoadmapExport{
		Format:  model.ExportFormat,
		Version: model.ExportVersion,
		Roadmap: full,
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf("attachment; filename=%q", exportFilename(full.Name)))
	if err := json.NewEncoder(w).Encode(exp); err != nil {
		log.Printf("write export: %v", err)
	}
}

// importRoadmap creates a new roadmap from an uploaded export file. The body
// limit is larger than the shared readJSON limit since a whole roadmap can be
// sizable; unknown fields are tolerated for forward compatibility.
func (s *Server) importRoadmap(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	var exp model.RoadmapExport
	if err := json.NewDecoder(r.Body).Decode(&exp); err != nil {
		writeClientErr(w, fmt.Errorf("invalid import file: %w", err))
		return
	}
	if exp.Format != model.ExportFormat {
		writeClientErr(w, fmt.Errorf("unrecognized file (not a Roadie export)"))
		return
	}
	if exp.Version > model.ExportVersion {
		writeClientErr(w, fmt.Errorf("import file version %d is newer than supported (%d)", exp.Version, model.ExportVersion))
		return
	}
	rm, err := s.store.ImportRoadmap(r.Context(), exp.Roadmap)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, rm)
}

// exportFilename turns a roadmap name into a safe download filename, keeping
// letters/digits and collapsing everything else to underscores.
func exportFilename(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	base := strings.Trim(b.String(), "_")
	if base == "" {
		base = "roadmap"
	}
	return base + ".roadie.json"
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

// Milestones

func (s *Server) createMilestone(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var req store.NewMilestone
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	m, err := s.store.CreateMilestone(r.Context(), id, req)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (s *Server) patchMilestone(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var patch store.MilestonePatch
	if err := readJSON(w, r, &patch); err != nil {
		writeClientErr(w, err)
		return
	}
	m, err := s.store.UpdateMilestone(r.Context(), id, patch)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) deleteMilestone(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	if err := s.store.DeleteMilestone(r.Context(), id); err != nil {
		s.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
