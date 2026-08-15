// Saved tracker queries ("favourites", notes/JIRA.md): operational
// reconciliation data owned by the recon view. Roadmap-scoped — the FK
// cascades on roadmap delete — but not roadmap content: nothing here appears
// in RoadmapFull, snapshots, exports or a duplicate, so restoring a plan never
// resurrects an old favourite.
//
// Names are unique per roadmap because the picker offers names alone. As with
// dependencies, the check is a pre-check under the roadmap lock rather than
// error-code sniffing; the unique index remains as a backstop.

package store

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/dnswlt/roadie/internal/model"
)

const trackerQueryCols = "id, roadmap_id, name, query"

func scanTrackerQuery(r rowScanner) (model.TrackerQuery, error) {
	var q model.TrackerQuery
	err := r.Scan(&q.ID, &q.RoadmapID, &q.Name, &q.Query)
	return q, err
}

// RoadmapIDByTrackerQuery returns the roadmap that owns the saved query, or
// ErrNotFound. It backs the server's access guard.
func (s *Store) RoadmapIDByTrackerQuery(ctx context.Context, id int64) (int64, error) {
	var roadmapID int64
	err := s.pool.QueryRow(ctx, `SELECT roadmap_id FROM tracker_queries WHERE id = $1`, id).Scan(&roadmapID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return roadmapID, err
}

// ListTrackerQueries returns a roadmap's saved queries ordered by name, the
// order the picker shows.
func (s *Store) ListTrackerQueries(ctx context.Context, roadmapID int64) ([]model.TrackerQuery, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+trackerQueryCols+` FROM tracker_queries WHERE roadmap_id = $1 ORDER BY name`,
		roadmapID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	queries := []model.TrackerQuery{}
	for rows.Next() {
		q, err := scanTrackerQuery(rows)
		if err != nil {
			return nil, err
		}
		queries = append(queries, q)
	}
	return queries, rows.Err()
}

// trackerQueryNameTaken reports whether another saved query (any but exceptID;
// 0 excludes none) already uses name in this roadmap. Call under the roadmap
// lock.
func trackerQueryNameTaken(ctx context.Context, tx pgx.Tx, roadmapID int64, name string, exceptID int64) (bool, error) {
	var taken bool
	err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tracker_queries WHERE roadmap_id = $1 AND name = $2 AND id <> $3)`,
		roadmapID, name, exceptID).Scan(&taken)
	return taken, err
}

// Both fields are stored trimmed: a name padded with spaces is
// indistinguishable in the picker, and stray whitespace is not query content.
func (s *Store) CreateTrackerQuery(ctx context.Context, roadmapID int64, name, query string) (model.TrackerQuery, error) {
	name = strings.TrimSpace(name)
	query = strings.TrimSpace(query)
	if name == "" {
		return model.TrackerQuery{}, invalidf("saved query name must not be empty")
	}
	if query == "" {
		return model.TrackerQuery{}, invalidf("saved query must not be empty")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.TrackerQuery{}, err
	}
	defer tx.Rollback(ctx)

	if err := s.lockRoadmap(ctx, tx, roadmapID); err != nil {
		return model.TrackerQuery{}, err
	}
	taken, err := trackerQueryNameTaken(ctx, tx, roadmapID, name, 0)
	if err != nil {
		return model.TrackerQuery{}, err
	}
	if taken {
		return model.TrackerQuery{}, invalidf("a saved query named %q already exists", name)
	}
	q, err := scanTrackerQuery(tx.QueryRow(ctx,
		`INSERT INTO tracker_queries (roadmap_id, name, query)
		 VALUES ($1, $2, $3) RETURNING `+trackerQueryCols,
		roadmapID, name, query))
	if err != nil {
		return model.TrackerQuery{}, err
	}
	return q, tx.Commit(ctx)
}

type TrackerQueryPatch struct {
	Name  model.Opt[string] `json:"name"`
	Query model.Opt[string] `json:"query"`
}

func (s *Store) UpdateTrackerQuery(ctx context.Context, id int64, p TrackerQueryPatch) (model.TrackerQuery, error) {
	if p.Name.Set {
		p.Name.Value = strings.TrimSpace(p.Name.Value)
		if p.Name.Value == "" {
			return model.TrackerQuery{}, invalidf("saved query name must not be empty")
		}
	}
	if p.Query.Set {
		p.Query.Value = strings.TrimSpace(p.Query.Value)
		if p.Query.Value == "" {
			return model.TrackerQuery{}, invalidf("saved query must not be empty")
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.TrackerQuery{}, err
	}
	defer tx.Rollback(ctx)

	var roadmapID int64
	err = tx.QueryRow(ctx, `SELECT roadmap_id FROM tracker_queries WHERE id = $1`, id).Scan(&roadmapID)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.TrackerQuery{}, ErrNotFound
	}
	if err != nil {
		return model.TrackerQuery{}, err
	}
	if err := s.lockRoadmap(ctx, tx, roadmapID); err != nil {
		return model.TrackerQuery{}, err
	}
	if p.Name.Set {
		taken, err := trackerQueryNameTaken(ctx, tx, roadmapID, p.Name.Value, id)
		if err != nil {
			return model.TrackerQuery{}, err
		}
		if taken {
			return model.TrackerQuery{}, invalidf("a saved query named %q already exists", p.Name.Value)
		}
	}
	q, err := scanTrackerQuery(tx.QueryRow(ctx,
		`UPDATE tracker_queries SET
		   name  = CASE WHEN $2::bool THEN $3 ELSE name  END,
		   query = CASE WHEN $4::bool THEN $5 ELSE query END,
		   updated_at = now()
		 WHERE id = $1 RETURNING `+trackerQueryCols,
		id, p.Name.Set, p.Name.Value, p.Query.Set, p.Query.Value))
	if err != nil {
		return model.TrackerQuery{}, err
	}
	return q, tx.Commit(ctx)
}

func (s *Store) DeleteTrackerQuery(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM tracker_queries WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
