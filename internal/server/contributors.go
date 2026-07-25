package server

import (
	"context"
	"log"
	"net/http"

	"github.com/dnswlt/roadie/internal/auth"
)

// recordContributor notes who made a successful edit to roadmapID. It is called
// from the snap wrapper, so every mutation is attributed from one place rather
// than from each handler.
//
// Like the auto-snapshot capture next to it this is best-effort: recording who
// edited must never fail the edit itself, so an error is logged and swallowed.
// With auth off there is no identity to attribute anything to, so nothing is
// written and the table stays empty — which the UI reads as "no contributor
// list to show" rather than as a roadmap nobody has touched.
func (s *Server) recordContributor(ctx context.Context, roadmapID int64) {
	id := auth.From(ctx)
	if id.IsAnonymous() {
		return
	}
	// Label falls back to email, then to the subject, so a provider that sends a
	// sparse profile still yields something displayable rather than a blank name.
	if err := s.store.RecordContributor(ctx, roadmapID, id.Subject, id.Label()); err != nil {
		log.Printf("record contributor (roadmap %d): %v", roadmapID, err)
	}
}

// listContributors returns everyone who has edited a roadmap, alphabetically.
// Contributors are editing metadata rather than roadmap content, so they get
// their own endpoint instead of riding in RoadmapFull: that payload is what
// snapshots serialize, and a restore must not rewrite the contributor list.
func (s *Server) listContributors(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	cs, err := s.store.ListContributors(r.Context(), id)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cs)
}
