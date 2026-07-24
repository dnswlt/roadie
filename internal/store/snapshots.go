package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

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
	// GetRoadmapFull reads a consistent snapshot, so the captured blob is never
	// torn by a concurrent edit. Encoding the (immutable) value and inserting it
	// in a separate transaction is fine: the snapshot represents that committed
	// point-in-time regardless of later edits.
	full, err := s.GetRoadmapFull(ctx, roadmapID)
	if err != nil {
		return model.Snapshot{}, err
	}
	data, err := encodeSnapshot(full)
	if err != nil {
		return model.Snapshot{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Snapshot{}, err
	}
	defer tx.Rollback(ctx)

	snap, err := insertSnapshot(ctx, tx, roadmapID, kind, name, data)
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

// encodeSnapshot serializes a roadmap into the stored payload (the export
// envelope JSON).
func encodeSnapshot(full model.RoadmapFull) ([]byte, error) {
	data, err := json.Marshal(model.RoadmapExport{
		Format:  model.ExportFormat,
		Version: model.ExportVersion,
		Roadmap: full,
	})
	if err != nil {
		return nil, fmt.Errorf("encode snapshot: %w", err)
	}
	return data, nil
}

// insertSnapshot writes one snapshot row within tx and returns its metadata.
func insertSnapshot(ctx context.Context, tx pgx.Tx, roadmapID int64, kind string, name *string, data []byte) (model.Snapshot, error) {
	return scanSnapshot(tx.QueryRow(ctx,
		`INSERT INTO snapshots (roadmap_id, name, kind, format_version, data)
		 VALUES ($1, $2, $3, $4, $5) RETURNING `+snapshotMetaCols,
		roadmapID, name, kind, model.ExportVersion, data))
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
// snapshot snapID, keeping the same roadmap (id and name). The whole thing runs
// in one transaction under the roadmap lock: it captures the pre-restore state
// as an auto snapshot (so a restore is itself reversible) and then swaps the
// contents, atomically — a concurrent editor's changes are either fully in the
// undo snapshot (committed before us) or fully rejected (blocked until we
// finish), never silently lost in between.
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

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Roadmap{}, err
	}
	defer tx.Rollback(ctx)

	// Lock the roadmap for the whole operation. Every mutation locks it too, so
	// from here no concurrent edit can commit until we're done.
	if err := s.lockRoadmap(ctx, tx, roadmapID); err != nil {
		return model.Roadmap{}, err
	}

	// Capture the pre-restore state as an auto snapshot *inside the lock*, so the
	// "undo" snapshot exactly matches what we're about to replace — no edit can
	// slip in between capturing it and replacing the contents.
	pre, err := getRoadmapFull(ctx, tx, roadmapID)
	if err != nil {
		return model.Roadmap{}, err
	}
	preData, err := encodeSnapshot(pre)
	if err != nil {
		return model.Roadmap{}, err
	}
	if _, err := insertSnapshot(ctx, tx, roadmapID, model.SnapshotAuto, nil, preData); err != nil {
		return model.Roadmap{}, err
	}
	if err := pruneAutoSnapshots(ctx, tx, roadmapID); err != nil {
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
