// The schedule-check extractor script (notes/schedule_check.md), one per
// roadmap at most: operational recon config exactly like the saved queries in
// queries.go — the FK cascades on roadmap delete, but nothing here appears in
// RoadmapFull, snapshots, exports or a duplicate, so restoring a plan never
// resurrects an old script.
//
// The store holds the source opaquely. Whether it compiles is a semantic
// question needing the Starlark interpreter, and it is answered in the server
// layer, the way JQL validity is.

package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/dnswlt/roadie/internal/model"
)

const trackerExtractorCols = "roadmap_id, source, updated_at"

func scanTrackerExtractor(r rowScanner) (model.TrackerExtractor, error) {
	var e model.TrackerExtractor
	err := r.Scan(&e.RoadmapID, &e.Source, &e.UpdatedAt)
	return e, err
}

// GetTrackerExtractor returns a roadmap's script, or ErrNotFound when it has
// none — which is the state the Recon tab explains and offers to fix, not an
// error.
func (s *Store) GetTrackerExtractor(ctx context.Context, roadmapID int64) (model.TrackerExtractor, error) {
	e, err := scanTrackerExtractor(s.pool.QueryRow(ctx,
		`SELECT `+trackerExtractorCols+` FROM tracker_extractors WHERE roadmap_id = $1`, roadmapID))
	if errors.Is(err, pgx.ErrNoRows) {
		return model.TrackerExtractor{}, ErrNotFound
	}
	return e, err
}

// PutTrackerExtractor stores the roadmap's script, replacing any earlier one.
// There is no create/update distinction to make: the roadmap is the identity.
func (s *Store) PutTrackerExtractor(ctx context.Context, roadmapID int64, source string) (model.TrackerExtractor, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.TrackerExtractor{}, err
	}
	defer tx.Rollback(ctx)

	if err := s.lockRoadmap(ctx, tx, roadmapID); err != nil {
		return model.TrackerExtractor{}, err
	}
	e, err := scanTrackerExtractor(tx.QueryRow(ctx,
		`INSERT INTO tracker_extractors (roadmap_id, source) VALUES ($1, $2)
		 ON CONFLICT (roadmap_id) DO UPDATE SET source = EXCLUDED.source, updated_at = now()
		 RETURNING `+trackerExtractorCols,
		roadmapID, source))
	if err != nil {
		return model.TrackerExtractor{}, err
	}
	return e, tx.Commit(ctx)
}

func (s *Store) DeleteTrackerExtractor(ctx context.Context, roadmapID int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM tracker_extractors WHERE roadmap_id = $1`, roadmapID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
