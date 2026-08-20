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

	"github.com/dnswlt/roadie/internal/auth"
	"github.com/dnswlt/roadie/internal/model"
	"github.com/dnswlt/roadie/internal/store"
	"github.com/dnswlt/roadie/internal/tracker"
)

type Server struct {
	store *store.Store
	mux   *http.ServeMux

	// auth is nil when the server runs unauthenticated, which is the default
	// and the only mode Roadie had before OIDC: everyone may see and edit
	// everything, and auth.From reports an anonymous identity. Handlers never
	// consult this field — they read the identity from the request context,
	// which is populated either way.
	auth *auth.Authenticator

	// tracker is optional deployment configuration. The route remains present
	// without one and reports 503, so a disabled feature is an API response rather
	// than an accidental fallthrough to the SPA.
	tracker tracker.Client

	// handler is mux wrapped in the middleware chain built by New; ServeHTTP
	// delegates to it.
	handler http.Handler

	// lastAuto records when each roadmap was last auto-snapshotted, so the
	// capture throttle (autoSnapshot) is an in-process check rather than a DB
	// round-trip — and, by claiming the window before capturing, collapses a
	// burst of concurrent mutations into one snapshot. See autoSnapshot.
	snapMu   sync.Mutex
	lastAuto map[int64]time.Time

	// hub fans change notifications out to a roadmap's SSE subscribers, so an
	// edit by one user prompts other viewers to refetch. See events.go.
	hub *hub
}

// Option configures a Server. Options keep New's signature stable as optional
// subsystems such as authentication and issue tracking are added.
type Option func(*Server)

// WithAuth turns on authentication: every request outside the login flow and
// the k8s probes needs a session, and the caller's identity is put into the
// request context. Without it the server stays fully open, as before.
func WithAuth(a *auth.Authenticator) Option {
	return func(s *Server) { s.auth = a }
}

// WithTracker enables the read-only external issue search used by Jira Recon.
func WithTracker(t tracker.Client) Option {
	return func(s *Server) { s.tracker = t }
}

func New(st *store.Store, static fs.FS, opts ...Option) *Server {
	s := &Server{store: st, mux: http.NewServeMux(), lastAuto: map[int64]time.Time{}, hub: newHub()}
	for _, opt := range opts {
		opt(s)
	}

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

	// Who am I / is auth even on. The frontend asks once at startup so the UI
	// learns the mode at runtime instead of at build time.
	s.mux.HandleFunc("GET /api/me", s.getMe)
	// Tracker search is deployment-wide: it contains no roadmap data. Ignore
	// decisions will be roadmap-scoped when they arrive, like saved queries.
	s.mux.HandleFunc("POST /api/tracker/search", s.searchTracker)
	// Saved tracker queries: roadmap-scoped operational data with visibility's
	// route shape — guard rather than snap (see tracker.go).
	s.mux.HandleFunc("GET /api/roadmaps/{id}/tracker-queries", s.guard(byRoadmapID, s.listTrackerQueries))
	s.mux.HandleFunc("POST /api/roadmaps/{id}/tracker-queries", s.guard(byRoadmapID, s.createTrackerQuery))
	s.mux.HandleFunc("PATCH /api/tracker-queries/{id}", s.guard(byTrackerQueryID, s.patchTrackerQuery))
	s.mux.HandleFunc("DELETE /api/tracker-queries/{id}", s.guard(byTrackerQueryID, s.deleteTrackerQuery))

	// Routes that name a roadmap — directly, or via a lane, item, milestone or
	// snapshot id — are wrapped in guard or snap, which is where the caller is
	// checked against that roadmap's visibility. Routes that name no roadmap are
	// exceptions by nature: listings filter in SQL, nothing exists yet to guard
	// during creation/import, and tracker search contains no Roadie data.
	s.mux.HandleFunc("GET /api/roadmaps", s.listRoadmaps)
	s.mux.HandleFunc("POST /api/roadmaps", s.createRoadmap)
	s.mux.HandleFunc("POST /api/roadmaps/import", s.importRoadmap)
	// The trash. A literal segment beats the {id} wildcard below, so this and
	// GET /api/roadmaps/{id} coexist. See trash.go.
	s.mux.HandleFunc("GET /api/roadmaps/trash", s.listTrash)
	s.mux.HandleFunc("POST /api/roadmaps/{id}/restore", s.guard(byRoadmapID, s.restoreRoadmap))
	s.mux.HandleFunc("DELETE /api/roadmaps/{id}/purge", s.guard(byRoadmapID, s.purgeRoadmap))
	s.mux.HandleFunc("POST /api/roadmaps/{id}/duplicate", s.guard(byRoadmapID, s.duplicateRoadmap))
	s.mux.HandleFunc("GET /api/roadmaps/{id}/export", s.guard(byRoadmapID, s.exportRoadmap))
	s.mux.HandleFunc("GET /api/roadmaps/{id}", s.guard(byRoadmapID, s.getRoadmap))
	s.mux.HandleFunc("PATCH /api/roadmaps/{id}", s.snap(snapThrottle, byRoadmapID, s.patchRoadmap))
	// Visibility is not roadmap content — it is not snapshotted, and a restore
	// does not revert it — so it gets its own route rather than riding in the
	// PATCH above, and guard rather than snap. Access alone isn't enough to
	// change it; the store additionally requires ownership.
	s.mux.HandleFunc("PUT /api/roadmaps/{id}/visibility", s.guard(byRoadmapID, s.putVisibility))
	// Deleting a roadmap moves it to the trash; no auto snapshot, because
	// nothing is destroyed (and a snapshot couldn't survive a real delete
	// anyway — the FK cascade would take it along).
	s.mux.HandleFunc("DELETE /api/roadmaps/{id}", s.guard(byRoadmapID, s.deleteRoadmap))
	s.mux.HandleFunc("POST /api/roadmaps/{id}/lanes", s.snap(snapThrottle, byRoadmapID, s.createLane))
	s.mux.HandleFunc("PUT /api/roadmaps/{id}/lane-order", s.snap(snapThrottle, byRoadmapID, s.reorderLanes))
	s.mux.HandleFunc("PATCH /api/lanes/{id}", s.snap(snapThrottle, byLaneID, s.patchLane))
	s.mux.HandleFunc("DELETE /api/lanes/{id}", s.snap(snapForce, byLaneID, s.deleteLane))
	s.mux.HandleFunc("POST /api/lanes/{id}/items", s.snap(snapThrottle, byLaneID, s.createItem))
	s.mux.HandleFunc("PATCH /api/items/{id}", s.snap(snapThrottle, byItemID, s.patchItem))
	s.mux.HandleFunc("DELETE /api/items/{id}", s.snap(snapForce, byItemID, s.deleteItem))
	s.mux.HandleFunc("PUT /api/roadmaps/{id}/schedule", s.snap(snapThrottle, byRoadmapID, s.putSchedule))
	s.mux.HandleFunc("POST /api/lanes/{id}/milestones", s.snap(snapThrottle, byLaneID, s.createMilestone))
	s.mux.HandleFunc("PATCH /api/milestones/{id}", s.snap(snapThrottle, byMilestoneID, s.patchMilestone))
	s.mux.HandleFunc("DELETE /api/milestones/{id}", s.snap(snapForce, byMilestoneID, s.deleteMilestone))
	// Dependencies are edges between items/milestones; reads ride in the
	// roadmap payload, so only the two mutations exist. Deleting one is
	// snapForce like the other deletes: an edge is not recoverable from
	// anything else.
	s.mux.HandleFunc("POST /api/roadmaps/{id}/dependencies", s.snap(snapThrottle, byRoadmapID, s.createDependency))
	s.mux.HandleFunc("DELETE /api/dependencies/{id}", s.snap(snapForce, byDependencyID, s.deleteDependency))

	// Snapshots (version history). Restore captures the pre-restore state in the
	// store, so it is deliberately not wrapped with s.snap.
	// Live change notifications (SSE): viewers of a roadmap subscribe here and
	// are told when it changes, so they can refetch. See events.go.
	s.mux.HandleFunc("GET /api/roadmaps/{id}/events", s.guard(byRoadmapID, s.handleEvents))

	s.mux.HandleFunc("GET /api/roadmaps/{id}/contributors", s.guard(byRoadmapID, s.listContributors))
	s.mux.HandleFunc("GET /api/roadmaps/{id}/snapshots", s.guard(byRoadmapID, s.listSnapshots))
	// Creating and naming a checkpoint add to a roadmap's history rather than
	// changing its contents, so they take guard and not snap: there is no
	// prior state worth capturing before one, and nothing for a subscriber to
	// refetch after it.
	s.mux.HandleFunc("POST /api/roadmaps/{id}/snapshots", s.guard(byRoadmapID, s.createSnapshot))
	// The snapshot routes take a snapshot id, so they resolve through it to the
	// roadmap that owns it: a snapshot is as private as its roadmap.
	s.mux.HandleFunc("GET /api/snapshots/{id}", s.guard(bySnapshotID, s.getSnapshot))
	s.mux.HandleFunc("PATCH /api/snapshots/{id}", s.guard(bySnapshotID, s.renameSnapshot))
	s.mux.HandleFunc("POST /api/snapshots/{id}/restore", s.guard(bySnapshotID, s.restoreSnapshot))
	s.mux.HandleFunc("DELETE /api/snapshots/{id}", s.guard(bySnapshotID, s.deleteSnapshot))

	s.mux.Handle("/", http.FileServerFS(static))

	s.handler = s.mux
	if s.auth != nil {
		s.auth.Routes(s.mux)
		// Order matters: the CSRF check sits inside the auth middleware, so it
		// only ever sees requests that already carry a valid session.
		s.handler = s.auth.Middleware(requireClientHeader(s.mux))
	}
	// Outermost, so it also covers what the auth middleware writes itself: the
	// redirect into the login flow, which carries a Set-Cookie.
	s.handler = cacheHeaders(s.handler)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

// assetPrefix holds the build's content-hashed output (web/build.mjs). A hashed
// URL changes whenever its bytes do, which is what makes caching it forever safe.
const assetPrefix = "/assets/"

// cacheHeaders is the whole cache policy. Hashed assets are immutable;
// everything else is roadmap data, a session cookie, or the index.html naming
// those hashes, and must never be stored. Sessions are cookies, not
// Authorization headers, so RFC 9111 does not stop a shared cache from keeping
// a private roadmap's JSON without this. Dev serves web/dist from disk and
// production serves the same tree from go:embed, both through here, so the two
// cache identically by construction rather than by discipline.
func cacheHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, assetPrefix) {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// requireClientHeader rejects mutating API calls that omit X-Client-Id.
//
// This is a CSRF defence, and it is only installed alongside authentication:
// with auth off there is no ambient authority to forge, and demanding the
// header would break plain curl against an API that is open by design.
//
// The header is already sent by every frontend request (web/src/api.ts) for
// SSE echo suppression, so this costs the client nothing. Its value here is
// that a custom header cannot be set on a cross-origin request without a
// preflight, and Roadie serves no CORS headers, so the preflight fails and the
// forged request is never sent. It backs up SameSite=Lax on the session cookie
// rather than replacing it.
func requireClientHeader(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			// Safe methods: no state change to forge.
		default:
			if strings.HasPrefix(r.URL.Path, "/api/") && r.Header.Get(clientIDHeader) == "" {
				writeJSON(w, http.StatusForbidden, map[string]string{
					"error": "missing " + clientIDHeader + " header",
				})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// meResponse gives the frontend its runtime capabilities alongside identity.
// Mode is what the UI keys off for account affordances; TrackerAvailable tells
// it whether to offer Recon without probing the search endpoint for a 503.
type meResponse struct {
	Mode             string `json:"mode"` // "open" or "oidc"
	Authenticated    bool   `json:"authenticated"`
	Name             string `json:"name,omitempty"`
	Email            string `json:"email,omitempty"`
	TrackerAvailable bool   `json:"trackerAvailable"`
}

func (s *Server) getMe(w http.ResponseWriter, r *http.Request) {
	if s.auth == nil {
		writeJSON(w, http.StatusOK, meResponse{Mode: "open", TrackerAvailable: s.tracker != nil})
		return
	}
	// Reaching here with auth on means the middleware admitted the request, so
	// there is always an identity.
	id := auth.From(r.Context())
	writeJSON(w, http.StatusOK, meResponse{
		Mode:             "oidc",
		Authenticated:    true,
		Name:             id.Name,
		Email:            id.Email,
		TrackerAvailable: s.tracker != nil,
	})
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
	roadmaps, err := s.store.ListRoadmaps(r.Context(), viewer(r))
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, roadmaps)
}

type nameReq struct {
	Name string `json:"name"`
}

// newRoadmapReq is createRoadmap's body. It is deliberately *not* nameReq with
// a visibility bolted on: readJSON rejects unknown fields, so widening the
// shared type would silently make `visibility` an accepted-and-ignored field on
// rename, duplicate and lane creation — an API that quietly swallows a field it
// does not honour.
type newRoadmapReq struct {
	Name string `json:"name"`
	// Visibility is "private" or "public"; empty means public. A private
	// roadmap needs an owner, so the store rejects one from an anonymous
	// caller. Changing it later is putVisibility's job, not a rename's.
	Visibility string `json:"visibility,omitempty"`
}

// ownership is the access decision for a roadmap the caller is about to
// create: the requested visibility, owned by whoever is asking. Anonymous
// callers own nothing, which is exactly what makes their roadmaps permanently
// public — there is nobody who could later make one private.
func ownership(r *http.Request, visibility string) store.Ownership {
	return store.Ownership{Visibility: visibility, Owner: viewer(r)}
}

func (s *Server) createRoadmap(w http.ResponseWriter, r *http.Request) {
	var req newRoadmapReq
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	rm, err := s.store.CreateRoadmap(r.Context(), req.Name, ownership(r, req.Visibility))
	if err != nil {
		s.writeErr(w, err)
		return
	}
	// Creating a roadmap can't go through the snap wrapper — that resolves the
	// roadmap id *before* the handler runs, and here it doesn't exist yet — so
	// attribute it explicitly. Without this the creator only shows up once they
	// edit something inside the roadmap, which makes them look like a latecomer
	// to the thing they started.
	s.recordContributor(r.Context(), rm.ID)
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
	// The copy is owned by whoever made it and inherits the source's visibility
	// (see store.DuplicateRoadmap), so duplicating a private roadmap gives you a
	// private one of your own rather than quietly publishing it.
	rm, err := s.store.DuplicateRoadmap(r.Context(), id, req.Name, viewer(r))
	if err != nil {
		s.writeErr(w, err)
		return
	}
	// Attribute the *copy*, not the source: rm.ID is the new roadmap, while the
	// {id} in the path is what it was copied from. (Another reason this can't be
	// snap-wrapped — the wrapper would resolve the path id and credit the wrong
	// roadmap.) The copy starts with one contributor, whoever made it.
	s.recordContributor(r.Context(), rm.ID)
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
	// An import is always public, and the visibility deliberately does not come
	// from the file: an export carries one (Roadmap is embedded in the payload)
	// and honouring it would let a file publish itself, or import as private and
	// belong to nobody. There is no way to ask for a private import either —
	// the body is the export envelope, with no room for a request of our own —
	// but the importer is recorded as the owner, so they can make it private
	// immediately afterwards from the roadmap menu.
	rm, err := s.store.ImportRoadmap(r.Context(), exp.Roadmap, ownership(r, model.VisibilityPublic))
	if err != nil {
		s.writeErr(w, err)
		return
	}
	// The importer is the new roadmap's first contributor. Contributors are not
	// part of the export envelope, so an imported roadmap never carries the
	// original's author list — it starts fresh with whoever brought it here.
	s.recordContributor(r.Context(), rm.ID)
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
	// Owned is derived per request and never stored, so GetRoadmapFull — which
	// also feeds snapshot capture, export and duplicate, none of which have a
	// user — does not compute it. Here there is a user, and the client needs it
	// to decide whether to offer the visibility control.
	full.Owned, err = s.store.IsRoadmapOwner(r.Context(), id, viewer(r))
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, full)
}

// putVisibility makes a roadmap private or public. guard has already checked
// that the caller can *see* the roadmap; the store additionally requires that
// they own it, and reports ErrNotFound otherwise. A roadmap with no owner —
// anything predating visibility, or created with auth off — therefore can never
// change: there is nobody who could.
func (s *Server) putVisibility(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var req struct {
		Visibility string `json:"visibility"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	rm, err := s.store.SetRoadmapVisibility(r.Context(), id, req.Visibility, viewer(r))
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rm)
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

// deleteRoadmap moves a roadmap to the trash, where it stays recoverable for
// trashTTL. Permanent deletion is a separate, explicit step — see purgeRoadmap
// in trash.go.
func (s *Server) deleteRoadmap(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	if err := s.store.TrashRoadmap(r.Context(), id); err != nil {
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

// Schedule

// putSchedule replaces a roadmap's entire schedule with the posted periods (an
// empty list clears it) and returns the stored periods, ordered by start date.
func (s *Server) putSchedule(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	var req struct {
		Periods []store.SchedulePeriodInput `json:"periods"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeClientErr(w, err)
		return
	}
	periods, err := s.store.ReplaceSchedule(r.Context(), id, req.Periods)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, periods)
}
