package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dnswlt/roadie/internal/model"
)

// maxAutoSnapshots caps how many auto snapshots are kept per roadmap. Older
// ones are pruned on each new auto capture. Named (manual) snapshots are never
// pruned and do not count against this cap.
const maxAutoSnapshots = 200

// snapshotMetaCols are the columns returned for snapshot listings; the data
// blob is deliberately excluded so listings stay cheap.
const snapshotMetaCols = "id, roadmap_id, name, kind, created_at"

func scanSnapshot(r rowScanner) (model.Snapshot, error) {
	var s model.Snapshot
	err := r.Scan(&s.ID, &s.RoadmapID, &s.Name, &s.Kind, &s.CreatedAt)
	return s, err
}

// CreateSnapshot captures the current full contents of roadmapID as a new
// snapshot. kind is model.SnapshotAuto or model.SnapshotManual; name is
// optional (nil for auto). The payload is the same RoadmapExport envelope the
// export feature produces, JSON-encoded into the data column. Creating an auto
// snapshot also prunes older auto snapshots down to maxAutoSnapshots.
func (s *Store) CreateSnapshot(ctx context.Context, roadmapID int64, kind string, name *string) (model.Snapshot, error) {
	if kind != model.SnapshotAuto && kind != model.SnapshotManual {
		return model.Snapshot{}, invalidf("invalid snapshot kind %q", kind)
	}
	full, err := s.GetRoadmapFull(ctx, roadmapID)
	if err != nil {
		return model.Snapshot{}, err
	}
	exp := model.RoadmapExport{
		Format:  model.ExportFormat,
		Version: model.ExportVersion,
		Roadmap: full,
	}
	data, err := json.Marshal(exp)
	if err != nil {
		return model.Snapshot{}, fmt.Errorf("encode snapshot: %w", err)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Snapshot{}, err
	}
	defer tx.Rollback(ctx)

	snap, err := scanSnapshot(tx.QueryRow(ctx,
		`INSERT INTO snapshots (roadmap_id, name, kind, format_version, data)
		 VALUES ($1, $2, $3, $4, $5) RETURNING `+snapshotMetaCols,
		roadmapID, name, kind, model.ExportVersion, data))
	if err != nil {
		return model.Snapshot{}, err
	}
	if kind == model.SnapshotAuto {
		if err := pruneAutoSnapshots(ctx, tx, roadmapID); err != nil {
			return model.Snapshot{}, err
		}
	}
	return snap, tx.Commit(ctx)
}

// pruneAutoSnapshots deletes auto snapshots of roadmapID beyond the newest
// maxAutoSnapshots. Named (manual) snapshots are untouched.
func pruneAutoSnapshots(ctx context.Context, tx pgx.Tx, roadmapID int64) error {
	_, err := tx.Exec(ctx,
		`DELETE FROM snapshots
		 WHERE roadmap_id = $1 AND kind = $2 AND id NOT IN (
		     SELECT id FROM snapshots
		     WHERE roadmap_id = $1 AND kind = $2
		     ORDER BY created_at DESC, id DESC
		     LIMIT $3
		 )`,
		roadmapID, model.SnapshotAuto, maxAutoSnapshots)
	return err
}

// ListSnapshots returns the metadata (no payload) for a roadmap's snapshots,
// newest first. Returns ErrNotFound if the roadmap does not exist.
func (s *Store) ListSnapshots(ctx context.Context, roadmapID int64) ([]model.Snapshot, error) {
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM roadmaps WHERE id = $1)`, roadmapID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	rows, err := s.pool.Query(ctx,
		`SELECT `+snapshotMetaCols+` FROM snapshots
		 WHERE roadmap_id = $1 ORDER BY created_at DESC, id DESC`, roadmapID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []model.Snapshot{}
	for rows.Next() {
		snap, err := scanSnapshot(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, snap)
	}
	return result, rows.Err()
}

// GetSnapshotContents decodes and returns the full roadmap contents stored in a
// snapshot, for read-only viewing. The returned RoadmapFull carries the
// historical IDs captured at snapshot time; it is meant for display, not
// mutation.
func (s *Store) GetSnapshotContents(ctx context.Context, snapID int64) (model.RoadmapFull, error) {
	var data []byte
	err := s.pool.QueryRow(ctx,
		`SELECT data FROM snapshots WHERE id = $1`, snapID).Scan(&data)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.RoadmapFull{}, ErrNotFound
	}
	if err != nil {
		return model.RoadmapFull{}, err
	}
	var exp model.RoadmapExport
	if err := json.Unmarshal(data, &exp); err != nil {
		return model.RoadmapFull{}, fmt.Errorf("decode snapshot %d: %w", snapID, err)
	}
	return exp.Roadmap, nil
}

// RenameSnapshot sets a snapshot's name and promotes it to a manual snapshot,
// so it is kept indefinitely (auto pruning ignores manual snapshots). An empty
// name is rejected. Returns the updated metadata.
func (s *Store) RenameSnapshot(ctx context.Context, snapID int64, name string) (model.Snapshot, error) {
	if name == "" {
		return model.Snapshot{}, invalidf("snapshot name must not be empty")
	}
	snap, err := scanSnapshot(s.pool.QueryRow(ctx,
		`UPDATE snapshots SET name = $2, kind = $3 WHERE id = $1 RETURNING `+snapshotMetaCols,
		snapID, name, model.SnapshotManual))
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Snapshot{}, ErrNotFound
	}
	return snap, err
}

// DeleteSnapshot removes a single snapshot.
func (s *Store) DeleteSnapshot(ctx context.Context, snapID int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM snapshots WHERE id = $1`, snapID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RestoreSnapshot replaces a roadmap's current contents with those stored in
// snapshot snapID, keeping the same roadmap (id and name). The pre-restore
// state is captured as an auto snapshot first, so a restore is itself
// reversible. The replacement runs in one transaction under the roadmap lock.
func (s *Store) RestoreSnapshot(ctx context.Context, snapID int64) (model.Roadmap, error) {
	var roadmapID int64
	var data []byte
	err := s.pool.QueryRow(ctx,
		`SELECT roadmap_id, data FROM snapshots WHERE id = $1`, snapID).Scan(&roadmapID, &data)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Roadmap{}, ErrNotFound
	}
	if err != nil {
		return model.Roadmap{}, err
	}
	var exp model.RoadmapExport
	if err := json.Unmarshal(data, &exp); err != nil {
		return model.Roadmap{}, fmt.Errorf("decode snapshot %d: %w", snapID, err)
	}

	// Capture the pre-restore state so the restore can be undone. Like export
	// and duplicate, this read is a separate transaction from the write below;
	// a roadmap has a single editor in practice.
	if _, err := s.CreateSnapshot(ctx, roadmapID, model.SnapshotAuto, nil); err != nil {
		return model.Roadmap{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Roadmap{}, err
	}
	defer tx.Rollback(ctx)

	if err := s.lockRoadmap(ctx, tx, roadmapID); err != nil {
		return model.Roadmap{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM lanes WHERE roadmap_id = $1`, roadmapID); err != nil {
		return model.Roadmap{}, err
	}
	if err := s.insertRoadmapContents(ctx, tx, roadmapID, exp.Roadmap); err != nil {
		return model.Roadmap{}, err
	}
	var rm model.Roadmap
	if err := tx.QueryRow(ctx,
		`UPDATE roadmaps SET updated_at = now() WHERE id = $1
		 RETURNING id, name, created_at, updated_at`, roadmapID).
		Scan(&rm.ID, &rm.Name, &rm.CreatedAt, &rm.UpdatedAt); err != nil {
		return model.Roadmap{}, err
	}
	return rm, tx.Commit(ctx)
}

// LatestSnapshotTime returns the creation time of the most recent snapshot for
// roadmapID, and whether any snapshot exists. The server uses it to throttle
// auto captures (skip if the last one is younger than the capture interval).
func (s *Store) LatestSnapshotTime(ctx context.Context, roadmapID int64) (time.Time, bool, error) {
	var t time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT created_at FROM snapshots WHERE roadmap_id = $1
		 ORDER BY created_at DESC, id DESC LIMIT 1`, roadmapID).Scan(&t)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, err
	}
	return t, true, nil
}
