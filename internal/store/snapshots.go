package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/dnswlt/roadie/internal/model"
)

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
// snapshot also downsamples older auto snapshots (see pruneAutoSnapshots).
func (s *Store) CreateSnapshot(ctx context.Context, roadmapID int64, kind string, name *string) (model.Snapshot, error) {
	if kind != model.SnapshotAuto && kind != model.SnapshotManual {
		return model.Snapshot{}, invalidf("invalid snapshot kind %q", kind)
	}
	// A manual snapshot is exempt from pruning, and the client shows its name in
	// place of its timestamp. An unnamed one would therefore be a row that is
	// kept forever and reads as an ordinary auto capture — so the name is what
	// makes it manual, not a decoration on it.
	if kind == model.SnapshotManual && (name == nil || *name == "") {
		return model.Snapshot{}, invalidf("a manual snapshot must have a name")
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

// pruneAutoSnapshots downsamples roadmapID's auto snapshots by age: everything
// from the last day is kept, older snapshots are thinned to one per hour for the
// past week and one per day beyond that (kept forever). Unlike a flat
// trailing-count window, a busy recent session can't evict a quieter older
// period. Named (manual) snapshots are never touched. Runs on every auto
// capture, so retention is maintained incrementally.
func pruneAutoSnapshots(ctx context.Context, tx pgx.Tx, roadmapID int64) error {
	// Candidates are auto snapshots older than a day; recent ones are kept in full
	// by never entering the set. Each candidate is bucketed by a granularity that
	// coarsens with age (hourly in the last week, daily before that), and the
	// newest per bucket is kept — a plain DISTINCT ON, no window function.
	_, err := tx.Exec(ctx, `
		WITH candidate AS (
		    SELECT id, date_trunc(
		               CASE WHEN created_at > now() - interval '7 days' THEN 'hour'
		                    ELSE 'day' END, created_at) AS bucket
		    FROM snapshots
		    WHERE roadmap_id = $1 AND kind = $2
		      AND created_at <= now() - interval '1 day'
		),
		keep AS (
		    SELECT DISTINCT ON (bucket) id FROM candidate ORDER BY bucket, id DESC
		)
		DELETE FROM snapshots
		WHERE id IN (SELECT id FROM candidate) AND id NOT IN (SELECT id FROM keep)`,
		roadmapID, model.SnapshotAuto)
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
	return normalizeSnapshotContents(exp.Roadmap), nil
}

// normalizeSnapshotContents upgrades a decoded snapshot payload to the current
// client-facing shape. A snapshot stores whatever RoadmapFull looked like when
// it was captured, so a blob taken before a collection field existed decodes
// with that field as a nil slice (JSON null / absent). The client contract is
// "no nulls: every collection is a present array", which the live read path
// (getRoadmapFull) already upholds; this is the equivalent backward-compat layer
// for historical blobs.
//
// Only a collection added *after* the snapshot feature can actually be absent
// from a stored blob — currently Periods and Dependencies. Every earlier
// collection (lanes, items, milestones, labels) predates snapshots, so all
// blobs already carry it; no guard is needed for those. Add a line here when a
// new collection is introduced after this point.
func normalizeSnapshotContents(full model.RoadmapFull) model.RoadmapFull {
	if full.Periods == nil {
		full.Periods = []model.SchedulePeriod{}
	}
	if full.Dependencies == nil {
		full.Dependencies = []model.Dependency{}
	}
	return full
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
//
// The restored lanes, items and milestones keep the database IDs and the
// updated_at stamps the snapshot recorded (insertPolicy.preserveIDs), because a
// database ID names a logical entity rather than a physical row: a restored item
// is the item that came back, not a new one wearing its number. That is what
// makes a version diff across a restore describe content rather than reading as
// replace-all, and what keeps a shareable ?item= link, the per-roadmap view
// preferences and a consumer's external dependency pointing where they did.
// Any later feature storing a reference outside the roadmap's delete cascade
// must accept that a restore re-binds it rather than leaving it dangling.
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

	// Read the milestone UIDs the current rows hold *before* deleting them: a
	// snapshot taken before UIDs existed carries none, and the database ID it
	// stored is then the only thing that says which milestone each entry was.
	uidByID, err := milestoneUIDsByID(ctx, tx, roadmapID)
	if err != nil {
		return model.Roadmap{}, err
	}

	if _, err := tx.Exec(ctx, `DELETE FROM lanes WHERE roadmap_id = $1`, roadmapID); err != nil {
		return model.Roadmap{}, err
	}
	// The schedule is roadmap-scoped, so the lane cascade above does not clear it;
	// remove it explicitly before insertRoadmapContents re-inserts the snapshot's.
	//
	// roadmap_contributors is roadmap-scoped too but is deliberately *not*
	// cleared here, and that asymmetry is the point rather than an oversight: the
	// schedule is roadmap content and reverts with everything else, while
	// contributors record who has edited this roadmap. Restoring a January
	// snapshot must not un-person whoever edited in June — and since a restore is
	// itself an edit, the person doing it is recorded as a contributor too.
	if _, err := tx.Exec(ctx, `DELETE FROM schedule_periods WHERE roadmap_id = $1`, roadmapID); err != nil {
		return model.Roadmap{}, err
	}
	if err := s.insertRoadmapContents(ctx, tx, roadmapID, exp.Roadmap,
		insertPolicy{preserveIDs: true, preserveUIDs: true, uidByID: uidByID}); err != nil {
		return model.Roadmap{}, err
	}
	// roadmapCols rather than a hand-listed subset: the roadmaps row grows
	// columns the client needs (visibility most recently), and a short list here
	// silently returns them zeroed.
	//
	// Note what is *not* restored: the snapshot blob carries a visibility, since
	// Roadmap is embedded in the RoadmapFull it stores, and insertRoadmapContents
	// ignores it. Restoring January must not republish what was made private in
	// June — the same rule that keeps contributors out of a restore. The blob's
	// roadmap UID is ignored for a different reason: the roadmap never went
	// anywhere, so it keeps the identity it already has.
	//
	// Unlike its contents, the roadmap row's own updated_at moves to now, because
	// the roadmap really did just change.
	rm, err := scanRoadmap(tx.QueryRow(ctx,
		`UPDATE roadmaps SET updated_at = now() WHERE id = $1 RETURNING `+roadmapCols, roadmapID))
	if err != nil {
		return model.Roadmap{}, err
	}
	return rm, tx.Commit(ctx)
}

// milestoneUIDsByID maps a roadmap's current milestone database IDs to their
// UIDs. See RestoreSnapshot, its only caller: it is read under the roadmap lock
// and consumed within the same transaction.
func milestoneUIDsByID(ctx context.Context, q querier, roadmapID int64) (map[int64]string, error) {
	rows, err := q.Query(ctx,
		`SELECT m.id, m.uid FROM milestones m
		 JOIN lanes l ON l.id = m.lane_id WHERE l.roadmap_id = $1`, roadmapID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var uid string
		if err := rows.Scan(&id, &uid); err != nil {
			return nil, err
		}
		out[id] = uid
	}
	return out, rows.Err()
}
