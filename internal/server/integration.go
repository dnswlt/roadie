package server

import "net/http"

// Discovery for integration milestones; the rules are in store/mirrors.go.
// Mirrors themselves need no routes: they are created through the ordinary
// milestones collection with a source UID in the body, and their dependencies
// through the ordinary dependencies collection.

// listIntegrationMilestones answers "what could this roadmap mirror". The path
// names the *consuming* roadmap — what guard authorizes, and what the
// already-mirrored flag is computed against.
func (s *Server) listIntegrationMilestones(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeClientErr(w, err)
		return
	}
	ms, err := s.store.ListIntegrationMilestones(r.Context(), id)
	if err != nil {
		s.writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ms)
}
