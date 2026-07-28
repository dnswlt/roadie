package server

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/dnswlt/roadie/internal/model"
)

const (
	// trashTTL is how long a deleted roadmap stays recoverable. Retention
	// policy, so it lives here rather than in the schema.
	trashTTL = 30 * 24 * time.Hour

	// trashSweepInterval is how often the sweeper looks for expired roadmaps.
	// It only has to be small relative to trashTTL — nothing depends on a
	// roadmap disappearing at a precise minute — so it stays coarse enough that
	// a long-running server does a handful of no-op queries a day.
	trashSweepInterval = 6 * time.Hour
)

// RunTrashSweeper purges roadmaps that have been in the trash for longer than
// trashTTL, once immediately and then every trashSweepInterval, until ctx is
// done. It blocks, so the caller owns the goroutine and its lifetime is visible
// where it is started; main runs it under the signal context, and it is
// deliberately not started by New, so tests get a server with no background
// writer of their data.
//
// The sweep on entry matters more than the interval: a process that restarts
// more often than trashSweepInterval would otherwise never reach a tick.
//
// Like the snapshot throttle this is per-process, so with several replicas each
// runs its own sweep — harmless, since the DELETE is idempotent and the losers
// simply purge nothing.
func (s *Server) RunTrashSweeper(ctx context.Context) {
	ticker := time.NewTicker(trashSweepInterval)
	defer ticker.Stop()
	for {
		s.sweepTrash(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) sweepTrash(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	n, err := s.store.PurgeExpiredTrash(ctx, trashTTL)
	if err != nil {
		// A shutdown mid-sweep cancels the query. That is the sweeper being
		// told to stop, not a failure, and logging it as one would put an error
		// line in the logs of a perfectly ordinary restart.
		if ctx.Err() == nil {
			log.Printf("trash sweep: %v", err)
		}
		return
	}
	if n > 0 {
		log.Printf("trash sweep: purged %d roadmap(s) deleted more than %s ago", n, trashTTL)
	}
}

// Trash endpoints.

// trashEntry is a trashed roadmap plus when it will be purged. PurgeAt is
// derived from trashTTL here rather than left to the client to work out, so the
// countdown the UI shows and the sweeper that does the deleting can't drift
// apart. It is deliberately not a column: the retention policy applies to rows
// already in the trash, so changing it must change their fate too.
type trashEntry struct {
	model.Roadmap
	PurgeAt time.Time `json:"purgeAt"`
}

// listTrash returns the roadmaps in the trash, most recently deleted first.
// Fetched on demand when the trash is opened, not as part of the roadmap list:
// the trash is a place you visit, not something every page load pays for.
func (s *Server) listTrash(w http.ResponseWriter, r *http.Request) {
	roadmaps, err := s.store.ListTrashedRoadmaps(r.Context())
	if err != nil {
		s.writeErr(w, err)
		return
	}
	entries := make([]trashEntry, 0, len(roadmaps))
	for _, rm := range roadmaps {
		entries = append(entries, trashEntry{Roadmap: rm, PurgeAt: rm.DeletedAt.Add(trashTTL)})
	}
	writeJSON(w, http.StatusOK, entries)
}

// restoreRoadmap brings a trashed roadmap back, with everything under it. It
// can't go through the snap wrapper — that would snapshot the roadmap while it
// is still trashed, and a trashed roadmap reads as absent — so it attributes
// the restore explicitly, as the snapshot restore does.
func (s *Server) restoreRoadmap(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	rm, err := s.store.RestoreRoadmap(r.Context(), id)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	s.recordContributor(r.Context(), rm.ID)
	writeJSON(w, http.StatusOK, rm)
}

// purgeRoadmap permanently deletes a trashed roadmap. This is the one
// irreversible operation in the product; the store refuses to purge a roadmap
// that isn't in the trash, so getting here always took two deliberate steps.
func (s *Server) purgeRoadmap(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	if err := s.store.PurgeRoadmap(r.Context(), id); err != nil {
		s.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
