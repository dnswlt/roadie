package server

import (
	"context"
	"log"
	"net/http"
	"time"

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

// snap wraps a mutating handler so the affected roadmap is auto-snapshotted
// *before* the mutation is applied — capturing the last-good state one can go
// back to. Capture is best-effort: a snapshot failure is logged and never
// blocks the user's edit, and an unresolvable roadmap (e.g. a delete that will
// 404) is simply skipped. The policy lives here in the route table rather than
// scattered through handler bodies.
func (s *Server) snap(mode snapMode, resolve roadmapResolver, h http.HandlerFunc) http.HandlerFunc {
	if mode == snapNone {
		return h
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if rid, err := resolve(s, r); err == nil {
			s.autoSnapshot(r.Context(), rid, mode)
		}
		h(w, r)
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
