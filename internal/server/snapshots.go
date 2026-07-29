package server

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/dnswlt/roadie/internal/auth"
	"github.com/dnswlt/roadie/internal/model"
)

// snapshotInterval throttles routine auto snapshots: at most one capture per
// roadmap per interval for non-destructive edits. Destructive edits (deletes)
// bypass the throttle so they are always individually recoverable.
const snapshotInterval = 5 * time.Minute

// snapMode selects the auto-snapshot policy for a mutating route.
type snapMode int

const (
	snapNone     snapMode = iota // no auto snapshot
	snapThrottle                 // capture at most once per snapshotInterval
	snapForce                    // always capture (before a destructive op)
)

// roadmapResolver extracts the roadmap id a request acts on from its path. The
// resolvers below map the {id} path value (a roadmap, lane, item or milestone)
// to the owning roadmap.
type roadmapResolver func(s *Server, r *http.Request) (int64, error)

func byRoadmapID(_ *Server, r *http.Request) (int64, error) { return pathID(r) }

func byLaneID(s *Server, r *http.Request) (int64, error) {
	id, err := pathID(r)
	if err != nil {
		return 0, err
	}
	return s.store.RoadmapIDByLane(r.Context(), id)
}

func byItemID(s *Server, r *http.Request) (int64, error) {
	id, err := pathID(r)
	if err != nil {
		return 0, err
	}
	return s.store.RoadmapIDByItem(r.Context(), id)
}

func byMilestoneID(s *Server, r *http.Request) (int64, error) {
	id, err := pathID(r)
	if err != nil {
		return 0, err
	}
	return s.store.RoadmapIDByMilestone(r.Context(), id)
}

func bySnapshotID(s *Server, r *http.Request) (int64, error) {
	id, err := pathID(r)
	if err != nil {
		return 0, err
	}
	return s.store.RoadmapIDBySnapshot(r.Context(), id)
}

// guard authorizes a request against the roadmap it acts on and, if the caller
// may not see that roadmap, answers 404 without running the handler.
//
// This is the only place authorization happens. It works because the resolvers
// above already answer the question authorization needs — *which* roadmap does
// this request touch — for a path id that may name a roadmap, a lane, an item,
// a milestone or a snapshot. Routes that name no roadmap (the listings, create,
// import) are not wrapped: a listing has no id to check, so it filters in SQL
// instead, and a create has nothing to authorize yet.
//
// An unresolvable roadmap deliberately falls through to the handler rather than
// 404ing here, which keeps the existing status codes exactly as they were: a
// malformed id still gets the handler's 400, and a missing one its 404. Nothing
// leaks, because the handler goes on to look up the very id that failed to
// resolve, and fails the same way.
func (s *Server) guard(resolve roadmapResolver, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if rid, err := resolve(s, r); err == nil && !s.allow(w, r, rid) {
			return
		}
		h(w, r)
	}
}

// allow reports whether the caller may act on roadmapID, writing the response
// itself when they may not.
//
// A denial is 404, not 403, matching how a trashed roadmap reads: something you
// cannot see does not exist. That also means a caller cannot probe for the
// existence of other people's private roadmaps by watching status codes.
func (s *Server) allow(w http.ResponseWriter, r *http.Request, roadmapID int64) bool {
	if err := s.store.CanAccessRoadmap(r.Context(), roadmapID, viewer(r)); err != nil {
		s.writeErr(w, err)
		return false
	}
	return true
}

// viewer is the subject the request is made under: the OIDC subject when
// authenticated, and "" when not — which is every request when the server runs
// with auth off. The empty subject is never stored in roadmap_members (the
// schema forbids it), so it matches nothing and needs no special case.
func viewer(r *http.Request) string { return auth.From(r.Context()).Subject }

// snap wraps a mutating handler so that the caller is authorized against the
// affected roadmap, the roadmap is auto-snapshotted *before* the mutation is
// applied — capturing the last-good state one can go back to — and, *after* it
// succeeds, the editor is recorded as a contributor and the roadmap's SSE
// subscribers are notified to refetch. Snapshot capture and attribution are
// both best-effort: a failure in either is logged and never blocks the user's
// edit, and an unresolvable roadmap (e.g. a delete that will 404) is simply
// skipped. The roadmap id is resolved up front because a delete makes it
// unresolvable afterwards. All of this policy lives here in the route table
// rather than scattered through handler bodies, which is what makes it a single
// choke point every mutation passes through.
//
// Authorization is folded in here rather than composed around it (guard(snap(…)))
// so that the two cannot come apart: a mutating route wrapped for snapshots is
// wrapped for access by construction, and the roadmap id both need is resolved
// once.
func (s *Server) snap(mode snapMode, resolve roadmapResolver, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rid, rerr := resolve(s, r)
		if rerr == nil {
			if !s.allow(w, r, rid) {
				return
			}
			if mode != snapNone {
				s.autoSnapshot(r.Context(), rid, mode)
			}
		}
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		h(rec, r)
		if rerr == nil && rec.status < 300 {
			s.recordContributor(r.Context(), rid)
			s.hub.broadcast(rid, r.Header.Get(clientIDHeader))
		}
	}
}

// autoSnapshot captures roadmapID's current state as an auto snapshot. A
// throttled capture is skipped if the roadmap was auto-snapshotted within
// snapshotInterval; a forced one (before a delete) always captures. The
// throttle is an in-process check under snapMu: claiming the window *before*
// capturing is what collapses a burst of concurrent mutations (a parent moved
// with its children, a multi-selection shift) into one snapshot instead of one
// per request. In-process means each replica may capture once per interval —
// harmless over-capture, since auto snapshots are pruned. Errors are logged,
// not returned: snapshotting must never fail a user's mutation.
func (s *Server) autoSnapshot(ctx context.Context, roadmapID int64, mode snapMode) {
	s.snapMu.Lock()
	last, seen := s.lastAuto[roadmapID]
	if mode == snapThrottle && seen && time.Since(last) < snapshotInterval {
		s.snapMu.Unlock()
		return // recent enough; no DB touched
	}
	s.lastAuto[roadmapID] = time.Now() // claim the window before capturing
	s.snapMu.Unlock()

	if _, err := s.store.CreateSnapshot(ctx, roadmapID, model.SnapshotAuto, nil); err != nil {
		log.Printf("auto snapshot (roadmap %d): %v", roadmapID, err)
	}
}

// Snapshot endpoints.

// listSnapshots returns a roadmap's snapshot metadata (no payloads), newest
// first.
func (s *Server) listSnapshots(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	snaps, err := s.store.ListSnapshots(r.Context(), id)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snaps)
}

// getSnapshot returns the full roadmap contents stored in a snapshot, for
// read-only viewing. The payload carries the historical IDs from capture time.
func (s *Server) getSnapshot(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	full, err := s.store.GetSnapshotContents(r.Context(), id)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, full)
}

// restoreSnapshot replaces the snapshot's roadmap with the snapshot's contents.
// The store captures the pre-restore state first, so this is itself reversible.
func (s *Server) restoreSnapshot(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	rm, err := s.store.RestoreSnapshot(r.Context(), id)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	// Restore isn't snap-wrapped (the store captures its own pre-restore state),
	// so the two things that wrapper does after a successful mutation have to
	// happen here: record who did it — a restore is an edit like any other, and
	// skipping it would leave the one unattributed change in the history — and
	// notify subscribers that the roadmap's contents changed.
	s.recordContributor(r.Context(), rm.ID)
	s.hub.broadcast(rm.ID, r.Header.Get(clientIDHeader))
	writeJSON(w, http.StatusOK, rm)
}

// deleteSnapshot removes a single snapshot.
func (s *Server) deleteSnapshot(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	if err := s.store.DeleteSnapshot(r.Context(), id); err != nil {
		s.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
