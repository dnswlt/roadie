package store

import (
	"context"

	"github.com/dnswlt/roadie/internal/model"
)

// RecordContributor notes that subject edited roadmapID just now: it adds the
// person on their first edit and afterwards only moves last_seen forward.
// first_seen sticks, so the pair brackets how long someone has been involved.
//
// The display name is refreshed on every edit rather than written once: an
// identity provider can rename a user, and with no user table there is nowhere
// else to re-read it from (see internal/auth). Last write wins, so a rename
// propagates the next time that person touches the roadmap.
//
// Callers pass a non-anonymous identity; with auth off there is nobody to
// attribute an edit to and nothing is recorded at all.
func (s *Store) RecordContributor(ctx context.Context, roadmapID int64, subject, name string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO roadmap_contributors (roadmap_id, subject, name)
		VALUES ($1, $2, $3)
		ON CONFLICT (roadmap_id, subject) DO UPDATE
		SET name = EXCLUDED.name, last_seen = now()`,
		roadmapID, subject, name)
	return err
}

// ListContributors returns everyone who has edited roadmapID, ordered by
// display name. Alphabetical is the point rather than a fallback: any
// activity-based order invites reading the list as a ranking of who
// contributed most, which is not something this data can support.
//
// Returns ErrNotFound if the roadmap does not exist. An existing roadmap with
// no contributors yields an empty slice — the normal case on a server running
// with auth off, where the UI hides the list entirely.
func (s *Store) ListContributors(ctx context.Context, roadmapID int64) ([]model.Contributor, error) {
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM roadmaps WHERE id = $1)`, roadmapID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT subject, name, first_seen, last_seen
		FROM roadmap_contributors
		WHERE roadmap_id = $1
		ORDER BY lower(name), subject`, roadmapID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []model.Contributor{}
	for rows.Next() {
		var c model.Contributor
		if err := rows.Scan(&c.Subject, &c.Name, &c.FirstSeen, &c.LastSeen); err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}
