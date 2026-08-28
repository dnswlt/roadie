// Package store provides Postgres persistence for the roadmap model and
// enforces its invariants: item nesting is at most one level deep, and a
// child item always lives in the same lane as its parent.
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/dnswlt/roadie/internal/model"
)

var ErrNotFound = errors.New("not found")

// ValidationError reports a client error (mapped to HTTP 400).
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalidf(format string, args ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, args...)}
}

// lockRoadmap takes the row lock every mutation of a roadmap's contents runs
// behind. Trashed roadmaps are excluded, which is what makes the trash freeze
// its contents: since every lane, item, milestone and schedule write passes
// through here (by roadmap, lane or item id), one clause makes them all 404
// rather than letting a stale tab keep editing something the user deleted.
func (s *Store) lockRoadmap(ctx context.Context, tx pgx.Tx, roadmapID int64) error {
	var dummy int64
	err := tx.QueryRow(ctx,
		`SELECT id FROM roadmaps WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, roadmapID).Scan(&dummy)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// lockRoadmapByLane locks the roadmap owning laneID and returns its id.
func (s *Store) lockRoadmapByLane(ctx context.Context, tx pgx.Tx, laneID int64) (int64, error) {
	var roadmapID int64
	err := tx.QueryRow(ctx, `SELECT roadmap_id FROM lanes WHERE id = $1`, laneID).Scan(&roadmapID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	return roadmapID, s.lockRoadmap(ctx, tx, roadmapID)
}

// lockRoadmapByItem locks the roadmap owning itemID and returns its id.
func (s *Store) lockRoadmapByItem(ctx context.Context, tx pgx.Tx, itemID int64) (int64, error) {
	var roadmapID int64
	err := tx.QueryRow(ctx, `SELECT roadmap_id FROM lanes WHERE id = (SELECT lane_id FROM items WHERE id = $1)`, itemID).Scan(&roadmapID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	return roadmapID, s.lockRoadmap(ctx, tx, roadmapID)
}

// lockRoadmapByMilestone locks the roadmap owning milestoneID and returns its id.
func (s *Store) lockRoadmapByMilestone(ctx context.Context, tx pgx.Tx, milestoneID int64) (int64, error) {
	var roadmapID int64
	err := tx.QueryRow(ctx,
		`SELECT roadmap_id FROM lanes WHERE id = (SELECT lane_id FROM milestones WHERE id = $1)`,
		milestoneID).Scan(&roadmapID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	return roadmapID, s.lockRoadmap(ctx, tx, roadmapID)
}

// RoadmapIDByLane returns the roadmap that owns laneID, or ErrNotFound. It is a
// plain (non-locking) lookup used to resolve which roadmap a request touches,
// e.g. for auto snapshots.
func (s *Store) RoadmapIDByLane(ctx context.Context, laneID int64) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx, `SELECT roadmap_id FROM lanes WHERE id = $1`, laneID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return id, err
}

// RoadmapIDByItem returns the roadmap that owns itemID, or ErrNotFound.
func (s *Store) RoadmapIDByItem(ctx context.Context, itemID int64) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx,
		`SELECT roadmap_id FROM lanes WHERE id = (SELECT lane_id FROM items WHERE id = $1)`,
		itemID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return id, err
}

// RoadmapIDBySnapshot returns the roadmap a snapshot belongs to, or
// ErrNotFound. Like the resolvers above it exists so the server can find out
// which roadmap a request acts on — here to authorize the snapshot routes,
// whose path id names a snapshot rather than a roadmap.
func (s *Store) RoadmapIDBySnapshot(ctx context.Context, snapID int64) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx, `SELECT roadmap_id FROM snapshots WHERE id = $1`, snapID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return id, err
}

// RoadmapIDByMilestone returns the roadmap that owns milestoneID, or ErrNotFound.
func (s *Store) RoadmapIDByMilestone(ctx context.Context, milestoneID int64) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx,
		`SELECT roadmap_id FROM lanes WHERE id = (SELECT lane_id FROM milestones WHERE id = $1)`,
		milestoneID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return id, err
}

type Store struct {
	pool *pgxpool.Pool
}

func Connect(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to database: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// Ping verifies database connectivity, backing the /readyz probe.
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

type rowScanner interface {
	Scan(dest ...any) error
}

// querier is the read subset shared by *pgxpool.Pool and pgx.Tx, so the same
// query code can run either directly on the pool or inside a transaction (e.g.
// to read a consistent snapshot, or under a lock held for a later write).
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

const itemCols = "id, lane_id, parent_id, title, description, start_date, end_date, rank, priority, labels, flagged, tentative, at_risk, updated_at"

func scanItem(r rowScanner) (model.Item, error) {
	var it model.Item
	var start, end time.Time
	err := r.Scan(&it.ID, &it.LaneID, &it.ParentID, &it.Title, &it.Description,
		&start, &end, &it.Rank, &it.Priority, &it.Labels, &it.Flagged,
		&it.Tentative, &it.AtRisk, &it.UpdatedAt)
	if err != nil {
		return model.Item{}, err
	}
	it.StartDate = model.NewDate(start)
	it.EndDate = model.NewDate(end)
	if it.Labels == nil {
		it.Labels = []string{}
	}
	return it, nil
}

// normalizeLabels trims, drops empties, and de-duplicates a label set while
// preserving first-seen order, so the stored set stays clean regardless of
// what the client sends.
func normalizeLabels(labels []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, l := range labels {
		l = strings.TrimSpace(l)
		if l == "" || seen[l] {
			continue
		}
		seen[l] = true
		out = append(out, l)
	}
	return out
}

const laneCols = "id, roadmap_id, name, position, color, updated_at"

func scanLane(r rowScanner) (model.Lane, error) {
	var l model.Lane
	err := r.Scan(&l.ID, &l.RoadmapID, &l.Name, &l.Position, &l.Color, &l.UpdatedAt)
	return l, err
}

const milestoneCols = "id, uid, lane_id, title, description, date, tentative, " +
	"integration_milestone, source_milestone_uid, updated_at"

func scanMilestone(r rowScanner) (model.Milestone, error) {
	var m model.Milestone
	var date time.Time
	var integration bool
	var sourceUID *string
	if err := r.Scan(&m.ID, &m.UID, &m.LaneID, &m.Title, &m.Description, &date, &m.Tentative,
		&integration, &sourceUID, &m.UpdatedAt); err != nil {
		return model.Milestone{}, err
	}
	m.Date = model.NewDate(date)
	// A linkage exists only when the milestone actually has a cross-roadmap
	// role. One of its two stored halves is always non-zero, so a plain
	// milestone has exactly one spelling: no linkage at all.
	if integration || sourceUID != nil {
		m.Linkage = &model.MilestoneLinkage{Integration: integration}
		if sourceUID != nil {
			m.Linkage.SourceUID = *sourceUID
		}
	}
	return m, nil
}

// Roadmaps

const roadmapCols = "id, uid, name, created_at, updated_at, deleted_at, visibility"

func scanRoadmap(r rowScanner) (model.Roadmap, error) {
	var rm model.Roadmap
	err := r.Scan(&rm.ID, &rm.UID, &rm.Name, &rm.CreatedAt, &rm.UpdatedAt, &rm.DeletedAt, &rm.Visibility)
	return rm, err
}

// scanOwnedRoadmap scans roadmapCols followed by the derived "owned" flag, for
// the listings that compute it in SQL against the requesting subject.
func scanOwnedRoadmap(r rowScanner) (model.Roadmap, error) {
	var rm model.Roadmap
	err := r.Scan(&rm.ID, &rm.UID, &rm.Name, &rm.CreatedAt, &rm.UpdatedAt, &rm.DeletedAt, &rm.Visibility, &rm.Owned)
	return rm, err
}

func queryRoadmaps(ctx context.Context, q querier, sql string, args ...any) ([]model.Roadmap, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []model.Roadmap{}
	for rows.Next() {
		rm, err := scanOwnedRoadmap(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, rm)
	}
	return result, rows.Err()
}

// ListRoadmaps returns the live roadmaps visible to viewer: the public ones,
// plus the private ones they are a member of. Trashed roadmaps are invisible
// here and reachable only through ListTrashedRoadmaps — everywhere else in the
// API a trashed roadmap simply does not exist.
//
// This and ListTrashedRoadmaps are the only store methods that take a viewer.
// Everywhere else the caller is checked once, in the server's route wrapper,
// against a roadmap id the request names; a listing has no id to check, so the
// filter has to happen in SQL. An empty viewer (the anonymous identity) matches
// no membership row, so it sees exactly the public roadmaps.
func (s *Store) ListRoadmaps(ctx context.Context, viewer string) ([]model.Roadmap, error) {
	return queryRoadmaps(ctx, s.pool,
		`SELECT `+roadmapCols+`, `+ownedExpr+` FROM roadmaps
		 WHERE deleted_at IS NULL AND (`+visibleExpr+`)
		 ORDER BY name, id`, viewer)
}

// ListTrashedRoadmaps returns the trashed roadmaps visible to viewer, most
// recently deleted first — the order in which someone hunting for what they
// just deleted will look.
func (s *Store) ListTrashedRoadmaps(ctx context.Context, viewer string) ([]model.Roadmap, error) {
	return queryRoadmaps(ctx, s.pool,
		`SELECT `+roadmapCols+`, `+ownedExpr+` FROM roadmaps
		 WHERE deleted_at IS NOT NULL AND (`+visibleExpr+`)
		 ORDER BY deleted_at DESC, id`, viewer)
}

// Ownership is the access decision taken when a roadmap comes into existence,
// and it is a separate argument from the roadmap's content on purpose: who may
// see a roadmap is not part of what the roadmap says. That is the same split
// that keeps visibility out of a restore and out of an imported file.
type Ownership struct {
	// Visibility is model.VisibilityPublic or model.VisibilityPrivate; empty
	// means public.
	Visibility string
	// Owner is the creator's OIDC subject, or "" when the caller is anonymous.
	// An owned roadmap can later have its visibility changed by that subject;
	// an unowned one is public forever. A private roadmap must have an owner,
	// which is what stops an anonymous caller creating one — a check on the
	// identity, not on the server's auth mode, so nothing here needs to know
	// which mode it is running in.
	Owner string
}

// CreateRoadmap creates an empty roadmap and, when the caller is authenticated,
// records them as its owner. Ownership is recorded for public roadmaps too: it
// does not affect who can reach them, but it is what decides who may later make
// them private.
func (s *Store) CreateRoadmap(ctx context.Context, name string, own Ownership) (model.Roadmap, error) {
	if name == "" {
		return model.Roadmap{}, invalidf("roadmap name must not be empty")
	}
	vis, err := normalizeVisibility(own.Visibility, own.Owner)
	if err != nil {
		return model.Roadmap{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Roadmap{}, err
	}
	defer tx.Rollback(ctx)

	rm, err := scanRoadmap(tx.QueryRow(ctx,
		`INSERT INTO roadmaps (name, visibility) VALUES ($1, $2) RETURNING `+roadmapCols, name, vis))
	if err != nil {
		return model.Roadmap{}, err
	}
	if err := insertOwner(ctx, tx, rm.ID, own.Owner); err != nil {
		return model.Roadmap{}, err
	}
	rm.Owned = own.Owner != ""
	return rm, tx.Commit(ctx)
}

func (s *Store) RenameRoadmap(ctx context.Context, id int64, name string) (model.Roadmap, error) {
	if name == "" {
		return model.Roadmap{}, invalidf("roadmap name must not be empty")
	}
	r, err := scanRoadmap(s.pool.QueryRow(ctx,
		`UPDATE roadmaps SET name = $2, updated_at = now()
		 WHERE id = $1 AND deleted_at IS NULL
		 RETURNING `+roadmapCols,
		id, name))
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Roadmap{}, ErrNotFound
	}
	return r, err
}

// TrashRoadmap moves a roadmap to the trash: the row is marked, not removed, so
// everything under it (lanes, items, milestones, schedule, snapshots,
// contributors) survives untouched and RestoreRoadmap can bring it all back.
// Trashing an already-trashed roadmap reports ErrNotFound — from the API's
// point of view it is already gone.
//
// None of the trash operations take the roadmap lock, unlike every mutation of
// a roadmap's *contents*, and they don't need to. Each is a single statement
// whose WHERE clause is also its precondition, which makes it a compare-and-
// swap: two concurrent trashes can't both report success. And an UPDATE or
// DELETE of the roadmaps row takes the same row lock lockRoadmap acquires with
// SELECT ... FOR UPDATE, so a concurrent edit is already serialized against it
// — it either commits first, or finds the roadmap gone.
func (s *Store) TrashRoadmap(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE roadmaps SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RestoreRoadmap brings a trashed roadmap back. updated_at is deliberately left
// alone: a restore returns the roadmap as it was, and bumping the timestamp
// would claim an edit that never happened.
func (s *Store) RestoreRoadmap(ctx context.Context, id int64) (model.Roadmap, error) {
	r, err := scanRoadmap(s.pool.QueryRow(ctx,
		`UPDATE roadmaps SET deleted_at = NULL
		 WHERE id = $1 AND deleted_at IS NOT NULL
		 RETURNING `+roadmapCols, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Roadmap{}, ErrNotFound
	}
	return r, err
}

// PurgeRoadmap permanently deletes a trashed roadmap and everything under it
// (via the FK cascade), including its snapshot history. A roadmap that is not
// in the trash is reported as ErrNotFound rather than destroyed: permanent
// deletion always takes two deliberate steps, and that is enforced here rather
// than left to the UI to remember.
func (s *Store) PurgeRoadmap(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM roadmaps WHERE id = $1 AND deleted_at IS NOT NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// PurgeExpiredTrash permanently deletes roadmaps that have been in the trash
// for longer than ttl, and reports how many it removed. Called by the server's
// trash sweeper; ttl is retention policy and lives there.
//
// A sweep racing a restore is safe without locking: under READ COMMITTED a
// DELETE that blocks on a concurrent UPDATE of the same row re-evaluates its
// WHERE against the updated row, so a roadmap restored a moment ago no longer
// matches deleted_at IS NOT NULL and is left alone. A sweep can never purge
// something the user just pulled out of the trash.
func (s *Store) PurgeExpiredTrash(ctx context.Context, ttl time.Duration) (int64, error) {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM roadmaps
		 WHERE deleted_at IS NOT NULL AND deleted_at < now() - make_interval(secs => $1)`,
		ttl.Seconds())
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// DeleteRoadmap permanently deletes a roadmap whether or not it is trashed. The
// API never calls this — user-facing deletion is TrashRoadmap followed by
// PurgeRoadmap — it exists for tests and tooling that need to clean up without
// the two-step dance.
func (s *Store) DeleteRoadmap(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM roadmaps WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// GetRoadmapFull returns the roadmap with all lanes and items, lanes ordered
// by position, items (and children) ordered by start date. It reads inside a
// REPEATABLE READ, read-only transaction so its several queries see one
// consistent snapshot even while the roadmap is edited concurrently — which
// matters both for callers that persist the result (export, duplicate, snapshot
// capture) and for a coherent view returned to the client.
func (s *Store) GetRoadmapFull(ctx context.Context, id int64) (model.RoadmapFull, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return model.RoadmapFull{}, err
	}
	defer tx.Rollback(ctx) // read-only: nothing to commit
	return getRoadmapFull(ctx, tx, id)
}

// getRoadmapFull performs the reads on q, which may be the pool or a
// transaction. Callers needing a consistent view (or a read under a lock they
// will write behind) pass a transaction; see GetRoadmapFull and RestoreSnapshot.
func getRoadmapFull(ctx context.Context, q querier, id int64) (model.RoadmapFull, error) {
	var full model.RoadmapFull
	// A trashed roadmap reads as absent. This one WHERE clause is what keeps a
	// roadmap in the trash from being opened, exported, duplicated, snapshotted
	// or restored into — every one of those paths comes through here.
	rm, err := scanRoadmap(q.QueryRow(ctx,
		`SELECT `+roadmapCols+` FROM roadmaps WHERE id = $1 AND deleted_at IS NULL`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return full, ErrNotFound
	}
	if err != nil {
		return full, err
	}
	full.Roadmap = rm

	laneRows, err := q.Query(ctx,
		`SELECT `+laneCols+` FROM lanes WHERE roadmap_id = $1 ORDER BY position, id`, id)
	if err != nil {
		return full, err
	}
	defer laneRows.Close()
	full.Lanes = []model.LaneFull{}
	laneIdx := map[int64]int{}
	for laneRows.Next() {
		l, err := scanLane(laneRows)
		if err != nil {
			return full, err
		}
		laneIdx[l.ID] = len(full.Lanes)
		full.Lanes = append(full.Lanes, model.LaneFull{
			Lane: l, Items: []model.ItemFull{}, Milestones: []model.Milestone{}})
	}
	if err := laneRows.Err(); err != nil {
		return full, err
	}

	itemRows, err := q.Query(ctx,
		`SELECT `+itemCols+` FROM items
		 WHERE lane_id IN (SELECT id FROM lanes WHERE roadmap_id = $1)
		 ORDER BY rank, id`, id)
	if err != nil {
		return full, err
	}
	defer itemRows.Close()
	var all []model.Item
	for itemRows.Next() {
		it, err := scanItem(itemRows)
		if err != nil {
			return full, err
		}
		all = append(all, it)
	}
	if err := itemRows.Err(); err != nil {
		return full, err
	}

	// Attach top-level items to lanes first, then children to their parents.
	parentIdx := map[int64][2]int{} // item id -> (lane index, item index)
	for _, it := range all {
		if it.ParentID != nil {
			continue
		}
		li := laneIdx[it.LaneID]
		parentIdx[it.ID] = [2]int{li, len(full.Lanes[li].Items)}
		full.Lanes[li].Items = append(full.Lanes[li].Items,
			model.ItemFull{Item: it, Children: []model.Item{}})
	}
	for _, it := range all {
		if it.ParentID == nil {
			continue
		}
		pos, ok := parentIdx[*it.ParentID]
		if !ok {
			return full, fmt.Errorf("item %d references missing parent %d", it.ID, *it.ParentID)
		}
		parent := &full.Lanes[pos[0]].Items[pos[1]]
		parent.Children = append(parent.Children, it)
	}

	msRows, err := q.Query(ctx,
		`SELECT `+milestoneCols+` FROM milestones
		 WHERE lane_id IN (SELECT id FROM lanes WHERE roadmap_id = $1)
		 ORDER BY date, id`, id)
	if err != nil {
		return full, err
	}
	defer msRows.Close()
	for msRows.Next() {
		m, err := scanMilestone(msRows)
		if err != nil {
			return full, err
		}
		li, ok := laneIdx[m.LaneID]
		if !ok {
			return full, fmt.Errorf("milestone %d references missing lane %d", m.ID, m.LaneID)
		}
		full.Lanes[li].Milestones = append(full.Lanes[li].Milestones, m)
	}
	if err := msRows.Err(); err != nil {
		return full, err
	}

	full.Periods, err = getSchedule(ctx, q, id)
	if err != nil {
		return full, err
	}
	full.Dependencies, err = getDependencies(ctx, q, id)
	if err != nil {
		return full, err
	}
	return full, nil
}

// DuplicateRoadmap deep-copies a roadmap under a new name. It is exactly
// "export then import" without the file: the copy gets fresh IDs throughout
// and dense lane positions / item ranks. An empty name reuses the source's,
// which uniqueRoadmapName then disambiguates with a " (n)" suffix.
//
// The source is read via GetRoadmapFull (a consistent REPEATABLE READ snapshot),
// so even under concurrent edits the copy is internally consistent: it reflects
// one committed point-in-time of the source. The subsequent import is a separate
// write transaction, but it targets a brand-new roadmap nothing else can touch.
//
// The copy is owned by whoever made it, not by the source's owner, and
// inherits the source's visibility: duplicating a private roadmap you can see
// gives you a private copy of your own, and copying a public one keeps it
// public. An anonymous caller can only ever have reached a public source, so
// the inherited visibility is never one they are not allowed to create.
//
// The import mode is stated here rather than left to the payload: a duplicate
// is always a new, independent roadmap, so it gets a fresh roadmap UID and
// fresh milestone UIDs however identity-laden the source is.
func (s *Store) DuplicateRoadmap(ctx context.Context, id int64, name, owner string) (model.Roadmap, error) {
	src, err := s.GetRoadmapFull(ctx, id)
	if err != nil {
		return model.Roadmap{}, err
	}
	if n := strings.TrimSpace(name); n != "" {
		src.Name = n
	}
	return s.ImportRoadmap(ctx, src, Ownership{Visibility: src.Visibility, Owner: owner}, ImportCopy)
}

// uniqueRoadmapName returns base, or base with a " (n)" suffix (n starting at
// 2) if a live roadmap of that name already exists *that the importer can see*.
// Roadmap names are not unique in the schema; this only avoids collisions at
// import time. Trashed roadmaps are ignored — a name nobody can see shouldn't
// push the copy to "(2)", and if the trashed one is later restored the two
// simply coexist.
//
// The visibility scoping is the same argument applied to private roadmaps, and
// it matters twice over: renaming your import to "Q3 Plan (2)" because of a
// stranger's private roadmap is both wrong and a disclosure — you would have
// learned a name you are not allowed to see.
func (s *Store) uniqueRoadmapName(ctx context.Context, tx pgx.Tx, base, viewer string) (string, error) {
	name := base
	for n := 2; ; n++ {
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM roadmaps
			 WHERE name = $2 AND deleted_at IS NULL AND (`+visibleExpr+`))`,
			viewer, name).Scan(&exists); err != nil {
			return "", err
		}
		if !exists {
			return name, nil
		}
		name = fmt.Sprintf("%s (%d)", base, n)
	}
}

// ImportMode selects what an import does with the identity carried in the file.
// The caller states it; the database contents never select it, so the same file
// imported twice does the same thing twice. There is no import-over-existing or
// replace mode — version history is how an existing roadmap is put back.
type ImportMode string

const (
	// ImportCopy creates an independent roadmap: fresh database IDs, a fresh
	// roadmap UID and a fresh UID for every milestone.
	ImportCopy ImportMode = "copy"
	// ImportTransfer brings in the roadmap the file names, keeping the roadmap
	// and milestone UIDs it carries. It writes nothing at all if any of them is
	// already here, and never falls back to copy semantics.
	ImportTransfer ImportMode = "transfer"
)

// validUID reports whether s has the canonical 8-4-4-4-12 hex shape of a UUID,
// the only thing the uid columns accept. An import file is user input, so a
// malformed UID has to be a rejection rather than a database cast error.
func validUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// importPolicy turns an import mode into the identity policy for the roadmap's
// contents, plus the UID for the roadmap row itself (nil = generate a fresh
// one). Every mode requires the file's UIDs, including a copy that will throw
// them away: a file without them predates what Roadie still imports. Checking
// before the first insert is what makes a transfer's rejection name the file's
// problem rather than a constraint violation halfway through.
func importPolicy(mode ImportMode, src model.RoadmapFull) (*string, insertPolicy, error) {
	if err := checkUID("this roadmap", src.UID); err != nil {
		return nil, insertPolicy{}, err
	}
	for _, lane := range src.Lanes {
		for _, ms := range lane.Milestones {
			if err := checkUID(fmt.Sprintf("milestone %q", ms.Title), ms.UID); err != nil {
				return nil, insertPolicy{}, err
			}
		}
	}
	switch mode {
	case ImportCopy:
		return nil, insertPolicy{}, nil
	case ImportTransfer:
		return &src.UID, insertPolicy{preserveUIDs: true}, nil
	default:
		return nil, insertPolicy{}, invalidf("unknown import mode %q", mode)
	}
}

func checkUID(what, uid string) error {
	if uid == "" {
		return invalidf("%s carries no identity, so this file is too old to import", what)
	}
	if !validUID(uid) {
		return invalidf("%s carries a malformed identity %q", what, uid)
	}
	return nil
}

// checkTransferable rejects the import if any identity the file brings already
// exists here, naming what it collided with; only the user can resolve that, so
// it is never papered over by generating new identities. Runs inside the import
// transaction before any insert, which is what makes a rejected transfer write
// nothing. Trashed roadmaps count — they still hold their UIDs.
//
// The refusal never depends on visibility — the UID is taken either way — but
// what the message *names* does: viewer is the importing subject, and a roadmap
// or milestone it cannot see is reported without its name, the same rule
// uniqueRoadmapName follows.
func checkTransferable(ctx context.Context, tx pgx.Tx, src model.RoadmapFull, viewer string) error {
	var name string
	var trashed, visible bool
	err := tx.QueryRow(ctx,
		`SELECT name, deleted_at IS NOT NULL, (`+visibleExpr+`) FROM roadmaps WHERE uid = $2`,
		viewer, src.UID).Scan(&name, &trashed, &visible)
	switch {
	case err == nil && !visible:
		return invalidf("this roadmap is already here, but you cannot see it — import it with new identifiers instead")
	case err == nil && trashed:
		return invalidf("this roadmap is already here as %q, in the trash — restore it from there, or import with new identifiers", name)
	case err == nil:
		return invalidf("this roadmap is already here as %q — import it with new identifiers instead, or use its version history to go back", name)
	case !errors.Is(err, pgx.ErrNoRows):
		return err
	}

	// Two milestones spelling the same UUID are one identity to the unique
	// index, so a file that repeats one would fail mid-insert rather than here;
	// the preflight owns that rejection too.
	uids := []string{}
	seen := map[string]bool{}
	for _, lane := range src.Lanes {
		for _, ms := range lane.Milestones {
			key := strings.ToLower(ms.UID)
			if seen[key] {
				return invalidf("milestone %q repeats an identity used earlier in this file", ms.Title)
			}
			seen[key] = true
			uids = append(uids, ms.UID)
		}
	}
	// ORDER BY 3 is the visibility column: with several conflicts, report one the
	// importer can actually be told about.
	var msTitle string
	err = tx.QueryRow(ctx,
		`SELECT ms.title, roadmaps.name, (`+visibleExpr+`) FROM milestones ms
		 JOIN lanes l ON l.id = ms.lane_id
		 JOIN roadmaps ON roadmaps.id = l.roadmap_id
		 WHERE ms.uid = ANY($2::uuid[])
		 ORDER BY 3 DESC LIMIT 1`,
		viewer, uids).Scan(&msTitle, &name, &visible)
	switch {
	case err == nil && !visible:
		return invalidf("a milestone in this file is already here, in a roadmap you cannot see — import with new identifiers instead")
	case err == nil:
		return invalidf("milestone %q is already here, in roadmap %q — import with new identifiers instead", msTitle, name)
	case !errors.Is(err, pgx.ErrNoRows):
		return err
	}
	return nil
}

// ImportRoadmap creates a brand-new roadmap from an exported RoadmapFull. The
// source's lane order (position) and item order (rank) are taken from the array
// order — not the stored fields — so the result is dense and consistent
// regardless of what the file contained. If the name collides with an existing
// roadmap it is disambiguated with a " (n)" suffix. The whole import runs in one
// transaction.
//
// Database IDs are always fresh; mode decides what happens to the UIDs (see
// ImportMode). Duplication is an import in ImportCopy mode, which is why the
// mode is an explicit argument rather than something derived from the payload:
// a duplicate must produce independent identities no matter what it copies.
//
// own decides the new roadmap's visibility and owner, and it comes from the
// caller, never from src: an export file carries a Visibility field (Roadmap is
// embedded in RoadmapFull) and it is ignored here for the same reason the
// embedded IDs and timestamps are. A file must not be able to grant anyone
// access, nor to publish itself. That holds for a transfer too: it moves
// content identity, not access.
func (s *Store) ImportRoadmap(ctx context.Context, src model.RoadmapFull, own Ownership, mode ImportMode) (model.Roadmap, error) {
	name := strings.TrimSpace(src.Name)
	if name == "" {
		return model.Roadmap{}, invalidf("roadmap name must not be empty")
	}
	if err := validateMirrorSources(src); err != nil {
		return model.Roadmap{}, err
	}
	vis, err := normalizeVisibility(own.Visibility, own.Owner)
	if err != nil {
		return model.Roadmap{}, err
	}
	uid, pol, err := importPolicy(mode, src)
	if err != nil {
		return model.Roadmap{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Roadmap{}, err
	}
	defer tx.Rollback(ctx)

	if mode == ImportTransfer {
		if err := checkTransferable(ctx, tx, src, own.Owner); err != nil {
			return model.Roadmap{}, err
		}
	}

	name, err = s.uniqueRoadmapName(ctx, tx, name, own.Owner)
	if err != nil {
		return model.Roadmap{}, err
	}

	rm, err := scanRoadmap(tx.QueryRow(ctx,
		`INSERT INTO roadmaps (uid, name, visibility)
		 VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3) RETURNING `+roadmapCols, uid, name, vis))
	if err != nil {
		return model.Roadmap{}, err
	}
	if err := insertOwner(ctx, tx, rm.ID, own.Owner); err != nil {
		return model.Roadmap{}, err
	}
	rm.Owned = own.Owner != ""

	if err := s.insertRoadmapContents(ctx, tx, rm.ID, src, pol); err != nil {
		return model.Roadmap{}, err
	}
	return rm, tx.Commit(ctx)
}

// insertPolicy is the identity insertRoadmapContents gives the rows it writes.
// The operation picks it before inserting anything; what is already in the
// database never picks it (notes/stable_uids.md).
type insertPolicy struct {
	// preserveIDs writes the source's own database IDs instead of letting the
	// sequence assign them, and each entity's own updated_at instead of now().
	// Only a restore does this: a database ID names a logical entity, not a
	// physical row. It
	// cannot collide — sequences never rewind, and the restore deletes the
	// roadmap's lanes first, in the same transaction, under the roadmap lock.
	preserveIDs bool
	// preserveUIDs writes the source's milestone UIDs instead of generating
	// fresh ones (a restore, and a transfer import).
	preserveUIDs bool
	// uidByID supplies the UID for a milestone whose source carries none — a
	// snapshot taken before UIDs existed — keyed by the database ID it held
	// before the restore deleted it. Only read under preserveUIDs.
	uidByID map[int64]string
}

// dbID returns the database ID to insert for a source row: its own when the
// policy preserves IDs, nil to let the sequence assign one.
func (p insertPolicy) dbID(id int64) *int64 {
	if !p.preserveIDs {
		return nil
	}
	return &id
}

// stamp returns the updated_at to insert, nil for now(). It rides with
// preserveIDs: restoring the same entity must not claim it was just edited.
//
// A zero time means the blob predates the field — every snapshot taken before
// lanes carried one — and then now() is the honest answer, since the restore
// really is the last thing that wrote the row.
func (p insertPolicy) stamp(t time.Time) *time.Time {
	if !p.preserveIDs || t.IsZero() {
		return nil
	}
	return &t
}

// mirrorSourceUID returns the source a milestone mirrors, nil for an owned one.
// Every policy preserves it — a copy gets a new mirror of the same source, never
// a mirror of nothing. Validated here so a malformed UID in a file is a
// rejection rather than a database cast error.
func mirrorSourceUID(ms model.Milestone) (*string, error) {
	if !ms.IsMirror() {
		return nil, nil
	}
	uid := ms.Linkage.SourceUID
	if !validUID(uid) {
		return nil, invalidf("milestone %q names a malformed source identity %q", ms.Title, uid)
	}
	return &uid, nil
}

// milestoneUID returns the UID to insert for a source milestone, nil to
// generate a fresh one.
func (p insertPolicy) milestoneUID(ms model.Milestone) *string {
	if !p.preserveUIDs {
		return nil
	}
	if ms.UID != "" {
		return &ms.UID
	}
	if uid, ok := p.uidByID[ms.ID]; ok {
		return &uid
	}
	return nil
}

// validateMirrorSources rejects a mirror whose source is another milestone
// in the same payload. Such a relationship is not a valid roadmap regardless of
// whether insertion preserves or regenerates the milestones' own UIDs.
func validateMirrorSources(src model.RoadmapFull) error {
	owned := map[string]string{}
	for _, lane := range src.Lanes {
		for _, ms := range lane.Milestones {
			if ms.UID != "" {
				owned[strings.ToLower(ms.UID)] = ms.Title
			}
		}
	}
	for _, lane := range src.Lanes {
		for _, ms := range lane.Milestones {
			if !ms.IsMirror() {
				continue
			}
			if title, ok := owned[strings.ToLower(ms.Linkage.SourceUID)]; ok {
				return invalidf("this roadmap mirrors its own milestone %q", title)
			}
		}
	}
	return nil
}

// insertRoadmapContents writes the lanes, items (with children), milestones
// and dependencies of src into the already-created roadmap roadmapID, within
// tx. Lane order (position) and item order (rank) come from the array order,
// not the stored fields, so the result is dense and consistent regardless of
// the source. It assumes roadmapID has no lanes yet (a fresh import target, or
// one just cleared by RestoreSnapshot). Shared by ImportRoadmap and
// RestoreSnapshot, which differ only in pol.
func (s *Store) insertRoadmapContents(ctx context.Context, tx pgx.Tx, roadmapID int64, src model.RoadmapFull, pol insertPolicy) error {
	// Dependency edges reference the ids embedded in src, so the item and
	// milestone inserts record how those map to the fresh rows. A source id of
	// 0 (a hand-written file omitting ids) is not recorded: it names nothing an
	// edge could refer to, and letting several id-less rows share the key would
	// bind an edge to whichever happened to come last.
	itemIDs := map[int64]int64{}
	msIDs := map[int64]int64{}
	// mirrorIDs marks the freshly written mirrors for the edge validation below;
	// mirrored is the one-mirror-per-source check, which has no unique index to
	// fall back on (milestones carry a lane, not a roadmap).
	mirrorIDs := map[int64]bool{}
	mirrored := map[string]bool{}

	// insertItem writes one item and returns its new ID. parentID is nil for
	// top-level items; rank is the caller-supplied dense index.
	insertItem := func(it model.Item, laneID int64, parentID *int64, rank int) (int64, error) {
		if strings.TrimSpace(it.Title) == "" {
			return 0, invalidf("item title must not be empty")
		}
		if it.StartDate.IsZero() || it.EndDate.IsZero() {
			return 0, invalidf("item %q is missing a start or end date", it.Title)
		}
		if it.EndDate.Before(it.StartDate.Time) {
			return 0, invalidf("item %q end date must not be before start date", it.Title)
		}
		if it.Priority != nil && (*it.Priority < 1 || *it.Priority > 4) {
			return 0, invalidf("item %q priority must be between 1 and 4", it.Title)
		}
		var id int64
		err := tx.QueryRow(ctx,
			`INSERT INTO items (id, lane_id, parent_id, title, description, start_date, end_date, rank, priority, labels, flagged, tentative, at_risk, updated_at)
			 VALUES (`+nextID("items")+`, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::timestamptz, now())) RETURNING id`,
			pol.dbID(it.ID), laneID, parentID, it.Title, it.Description, it.StartDate.Time, it.EndDate.Time,
			rank, it.Priority, normalizeLabels(it.Labels), it.Flagged, it.Tentative, it.AtRisk,
			pol.stamp(it.UpdatedAt)).Scan(&id)
		return id, err
	}

	for pos, lane := range src.Lanes {
		laneName := strings.TrimSpace(lane.Name)
		if laneName == "" {
			return invalidf("lane name must not be empty")
		}
		color := lane.Color
		if !validLaneColor(color) {
			color = laneColors[pos%len(laneColors)]
		}
		var laneID int64
		if err := tx.QueryRow(ctx,
			`INSERT INTO lanes (id, roadmap_id, name, position, color, updated_at)
			 VALUES (`+nextID("lanes")+`, $2, $3, $4, $5, COALESCE($6::timestamptz, now())) RETURNING id`,
			pol.dbID(lane.ID), roadmapID, laneName, pos, color,
			pol.stamp(lane.UpdatedAt)).Scan(&laneID); err != nil {
			return err
		}
		for rank, item := range lane.Items {
			parentID, err := insertItem(item.Item, laneID, nil, rank)
			if err != nil {
				return err
			}
			if item.ID != 0 {
				itemIDs[item.ID] = parentID
			}
			for crank, child := range item.Children {
				childID, err := insertItem(child, laneID, &parentID, crank)
				if err != nil {
					return err
				}
				if child.ID != 0 {
					itemIDs[child.ID] = childID
				}
			}
		}
		for _, ms := range lane.Milestones {
			if strings.TrimSpace(ms.Title) == "" {
				return invalidf("milestone title must not be empty")
			}
			if ms.Date.IsZero() {
				return invalidf("milestone %q is missing a date", ms.Title)
			}
			// Shape only. Whether a mirror's source exists here says nothing
			// about whether the file is well-formed, so it is not resolved.
			sourceUID, err := mirrorSourceUID(ms)
			if err != nil {
				return err
			}
			if sourceUID != nil {
				if ms.IsIntegration() {
					return invalidf("milestone %q is both a mirror and an integration milestone", ms.Title)
				}
				key := strings.ToLower(*sourceUID)
				if mirrored[key] {
					return invalidf("milestone %q mirrors a source this roadmap already mirrors", ms.Title)
				}
				mirrored[key] = true
			}
			var msID int64
			if err := tx.QueryRow(ctx,
				`INSERT INTO milestones (id, uid, lane_id, title, description, date, tentative, integration_milestone, source_milestone_uid, updated_at)
				 VALUES (`+nextID("milestones")+`, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5, $6, $7, $8, $9::uuid, COALESCE($10::timestamptz, now()))
				 RETURNING id`,
				pol.dbID(ms.ID), pol.milestoneUID(ms), laneID, ms.Title, ms.Description, ms.Date.Time,
				ms.Tentative && sourceUID == nil, ms.IsIntegration(), sourceUID,
				pol.stamp(ms.UpdatedAt)).Scan(&msID); err != nil {
				return err
			}
			if ms.ID != 0 {
				msIDs[ms.ID] = msID
			}
			if sourceUID != nil {
				mirrorIDs[msID] = true
			}
		}
	}
	if err := insertDependencies(ctx, tx, roadmapID, src, itemIDs, msIDs, mirrorIDs); err != nil {
		return err
	}
	// The schedule is roadmap-scoped (not under any lane), so it is inserted once
	// here rather than per lane. Periods get fresh IDs under every policy: they
	// are replaced as a set and compared by value, so nothing outside the table
	// ever names one.
	return insertSchedulePeriods(ctx, tx, roadmapID, src.Periods)
}

// nextID is the id expression the insert statements above use for $1: the
// source's own database ID when one is supplied, otherwise the table's own
// sequence — the same value the column default would have produced. COALESCE
// short-circuits, so passing an ID does not burn a sequence number.
func nextID(table string) string {
	return fmt.Sprintf("COALESCE($1::bigint, nextval(pg_get_serial_sequence('%s', 'id')))", table)
}

// Lanes

// laneColors are the color themes a swimlane can use; they are also
// auto-assigned round-robin when lanes are created. Must stay in step with
// LANE_COLORS in web/src/colors.ts — the name is what is stored, and the
// frontend owns the hex. CreateLane passes this slice to Postgres rather than
// repeating it in SQL, so the round-robin cannot drift from the valid set.
var laneColors = []string{"blue", "green", "red", "orange", "purple", "gray"}

func validLaneColor(c string) bool {
	for _, v := range laneColors {
		if v == c {
			return true
		}
	}
	return false
}

func (s *Store) CreateLane(ctx context.Context, roadmapID int64, name string) (model.Lane, error) {
	if name == "" {
		return model.Lane{}, invalidf("lane name must not be empty")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Lane{}, err
	}
	defer tx.Rollback(ctx)

	if err := s.lockRoadmap(ctx, tx, roadmapID); err != nil {
		return model.Lane{}, err
	}

	l, err := scanLane(tx.QueryRow(ctx,
		`WITH pos AS (SELECT COALESCE(MAX(position) + 1, 0) AS p FROM lanes WHERE roadmap_id = $1)
		 INSERT INTO lanes (roadmap_id, name, position, color)
		 SELECT r.id, $2, pos.p, ($3::text[])[(pos.p % array_length($3::text[], 1)) + 1]
		 FROM roadmaps r, pos WHERE r.id = $1
		 RETURNING `+laneCols,
		roadmapID, name, laneColors))
	if err != nil {
		return model.Lane{}, err
	}
	return l, tx.Commit(ctx)
}

type LanePatch struct {
	Name  model.Opt[string] `json:"name"`
	Color model.Opt[string] `json:"color"`
}

func (s *Store) UpdateLane(ctx context.Context, id int64, p LanePatch) (model.Lane, error) {
	if p.Name.Set && p.Name.Value == "" {
		return model.Lane{}, invalidf("lane name must not be empty")
	}
	if p.Color.Set && !validLaneColor(p.Color.Value) {
		return model.Lane{}, invalidf("invalid lane color %q (want one of %v)", p.Color.Value, laneColors)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Lane{}, err
	}
	defer tx.Rollback(ctx)

	if _, err := s.lockRoadmapByLane(ctx, tx, id); err != nil {
		return model.Lane{}, err
	}

	l, err := scanLane(tx.QueryRow(ctx,
		`UPDATE lanes SET name = CASE WHEN $2 THEN $3 ELSE name END,
		        color = CASE WHEN $4 THEN $5 ELSE color END,
		        updated_at = now()
		 WHERE id = $1
		 RETURNING `+laneCols,
		id, p.Name.Set, p.Name.Value, p.Color.Set, p.Color.Value))
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Lane{}, ErrNotFound
	}
	if err != nil {
		return model.Lane{}, err
	}
	return l, tx.Commit(ctx)
}

func (s *Store) DeleteLane(ctx context.Context, id int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := s.lockRoadmapByLane(ctx, tx, id); err != nil {
		return err
	}

	tag, err := tx.Exec(ctx, `DELETE FROM lanes WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ReorderLanes sets the lane order of a roadmap. laneIDs must contain exactly
// the IDs of the roadmap's lanes, in the desired order.
func (s *Store) ReorderLanes(ctx context.Context, roadmapID int64, laneIDs []int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if err := s.lockRoadmap(ctx, tx, roadmapID); err != nil {
		return err
	}

	rows, err := tx.Query(ctx,
		`SELECT id FROM lanes WHERE roadmap_id = $1 ORDER BY position`, roadmapID)
	if err != nil {
		return err
	}
	existing := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		existing[id] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(laneIDs) != len(existing) {
		return invalidf("lane order must list all %d lanes of the roadmap", len(existing))
	}
	for _, id := range laneIDs {
		if !existing[id] {
			return invalidf("lane %d does not belong to roadmap %d", id, roadmapID)
		}
		delete(existing, id) // catches duplicates via the length check above
	}
	if len(existing) != 0 {
		return invalidf("lane order contains duplicate IDs")
	}
	for i, id := range laneIDs {
		if _, err := tx.Exec(ctx,
			`UPDATE lanes SET position = $2, updated_at = now() WHERE id = $1`, id, i); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Items

type NewItem struct {
	Title       string     `json:"title"`
	Description string     `json:"description"`
	StartDate   model.Date `json:"startDate"`
	EndDate     model.Date `json:"endDate"`
	ParentID    *int64     `json:"parentId"`
	// Slot within the container, clamped to [0, len]. Absent = append, which is
	// why this is an Opt rather than a plain int: rank 0 is a real position and
	// must not be confused with "unspecified".
	Rank model.Opt[int] `json:"rank"`
}

func (s *Store) CreateItem(ctx context.Context, laneID int64, n NewItem) (model.Item, error) {
	if n.Title == "" {
		return model.Item{}, invalidf("item title must not be empty")
	}
	if n.StartDate.IsZero() || n.EndDate.IsZero() {
		return model.Item{}, invalidf("item start and end dates are required")
	}
	if n.EndDate.Before(n.StartDate.Time) {
		return model.Item{}, invalidf("item end date must not be before start date")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Item{}, err
	}
	defer tx.Rollback(ctx)

	roadmapID, err := s.lockRoadmapByLane(ctx, tx, laneID)
	if err != nil {
		return model.Item{}, err
	}

	if n.ParentID != nil {
		var parentLane, parentRoadmap int64
		var grandparent *int64
		err := tx.QueryRow(ctx,
			`SELECT i.lane_id, l.roadmap_id, i.parent_id
			 FROM items i JOIN lanes l ON l.id = i.lane_id WHERE i.id = $1`, *n.ParentID).
			Scan(&parentLane, &parentRoadmap, &grandparent)
		if errors.Is(err, pgx.ErrNoRows) {
			return model.Item{}, invalidf("parent item %d not found", *n.ParentID)
		}
		if err != nil {
			return model.Item{}, err
		}
		if grandparent != nil {
			return model.Item{}, invalidf("items can only be nested one level deep")
		}
		if parentRoadmap != roadmapID {
			return model.Item{}, invalidf("parent item %d belongs to a different roadmap", *n.ParentID)
		}
		// Children always live in their parent's lane.
		laneID = parentLane
	} else {
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM lanes WHERE id = $1)`, laneID).Scan(&exists); err != nil {
			return model.Item{}, err
		}
		if !exists {
			return model.Item{}, ErrNotFound
		}
	}

	// New items go to the end of their container (lane for top-level items,
	// parent for children), or into an explicit slot when Rank is set; ranks
	// stay dense per container either way. This is the same clamp-and-shift
	// UpdateItem performs, minus closing a gap in an old container — a new item
	// has none. Doing it here rather than as a follow-up rank PATCH keeps the
	// shift and the insert in one transaction under the roadmap lock, so a
	// concurrent create in the same container cannot land between them.
	var count int
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM items WHERE lane_id = $1 AND parent_id IS NOT DISTINCT FROM $2`,
		laneID, n.ParentID).Scan(&count); err != nil {
		return model.Item{}, err
	}
	rank := count
	if n.Rank.Set {
		rank = max(0, min(n.Rank.Value, count))
		if _, err := tx.Exec(ctx,
			`UPDATE items SET rank = rank + 1, updated_at = now()
			 WHERE lane_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND rank >= $3`,
			laneID, n.ParentID, rank); err != nil {
			return model.Item{}, err
		}
	}
	row := tx.QueryRow(ctx,
		`INSERT INTO items (lane_id, parent_id, title, description, start_date, end_date, rank)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING `+itemCols,
		laneID, n.ParentID, n.Title, n.Description, n.StartDate.Time, n.EndDate.Time, rank)
	it, err := scanItem(row)
	if err != nil {
		return model.Item{}, err
	}
	return it, tx.Commit(ctx)
}

type ItemPatch struct {
	Title       model.Opt[string]     `json:"title"`
	Description model.Opt[string]     `json:"description"`
	StartDate   model.Opt[model.Date] `json:"startDate"`
	EndDate     model.Opt[model.Date] `json:"endDate"`
	LaneID      model.Opt[int64]      `json:"laneId"`
	ParentID    model.Opt[*int64]     `json:"parentId"`
	Rank        model.Opt[int]        `json:"rank"`
	Priority    model.Opt[*int]       `json:"priority"`
	Labels      model.Opt[[]string]   `json:"labels"`
	Flagged     model.Opt[bool]       `json:"flagged"`
	Tentative   model.Opt[bool]       `json:"tentative"`
	AtRisk      model.Opt[bool]       `json:"atRisk"`
}

func ptrEq(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// UpdateItem applies a partial update. Moves (lane change, reparenting) go
// through here as well; children follow their parent's lane automatically.
func (s *Store) UpdateItem(ctx context.Context, id int64, p ItemPatch) (model.Item, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Item{}, err
	}
	defer tx.Rollback(ctx)

	roadmapID, err := s.lockRoadmapByItem(ctx, tx, id)
	if err != nil {
		return model.Item{}, err
	}

	row := tx.QueryRow(ctx, `SELECT `+itemCols+` FROM items WHERE id = $1`, id)
	cur, err := scanItem(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Item{}, ErrNotFound
	}
	if err != nil {
		return model.Item{}, err
	}

	next := cur
	if p.Title.Set {
		next.Title = p.Title.Value
	}
	if p.Description.Set {
		next.Description = p.Description.Value
	}
	if p.StartDate.Set {
		next.StartDate = p.StartDate.Value
	}
	if p.EndDate.Set {
		next.EndDate = p.EndDate.Value
	}
	if p.ParentID.Set {
		next.ParentID = p.ParentID.Value
	}
	if p.LaneID.Set {
		next.LaneID = p.LaneID.Value
	}
	if p.Priority.Set {
		next.Priority = p.Priority.Value
	}
	if p.Labels.Set {
		next.Labels = normalizeLabels(p.Labels.Value)
	}
	if p.Flagged.Set {
		next.Flagged = p.Flagged.Value
	}
	if p.Tentative.Set {
		next.Tentative = p.Tentative.Value
	}
	if p.AtRisk.Set {
		next.AtRisk = p.AtRisk.Value
	}

	if next.Title == "" {
		return model.Item{}, invalidf("item title must not be empty")
	}
	if next.Priority != nil && (*next.Priority < 1 || *next.Priority > 4) {
		return model.Item{}, invalidf("priority must be between 1 and 4")
	}
	if next.StartDate.IsZero() || next.EndDate.IsZero() {
		return model.Item{}, invalidf("item start and end dates must not be null")
	}
	if next.EndDate.Before(next.StartDate.Time) {
		return model.Item{}, invalidf("item end date must not be before start date")
	}

	if next.ParentID != nil {
		pid := *next.ParentID
		if pid == id {
			return model.Item{}, invalidf("item cannot be its own parent")
		}
		var hasChildren bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM items WHERE parent_id = $1)`, id).Scan(&hasChildren); err != nil {
			return model.Item{}, err
		}
		if hasChildren {
			return model.Item{}, invalidf("an item with children cannot become a child itself")
		}
		var parentLane, parentRoadmap int64
		var grandparent *int64
		err := tx.QueryRow(ctx,
			`SELECT i.lane_id, l.roadmap_id, i.parent_id
			 FROM items i JOIN lanes l ON l.id = i.lane_id WHERE i.id = $1`, pid).
			Scan(&parentLane, &parentRoadmap, &grandparent)
		if errors.Is(err, pgx.ErrNoRows) {
			return model.Item{}, invalidf("parent item %d not found", pid)
		}
		if err != nil {
			return model.Item{}, err
		}
		if grandparent != nil {
			return model.Item{}, invalidf("items can only be nested one level deep")
		}
		if parentRoadmap != roadmapID {
			return model.Item{}, invalidf("parent item %d belongs to a different roadmap", pid)
		}
		if p.LaneID.Set && p.LaneID.Value != parentLane {
			return model.Item{}, invalidf("child items inherit their parent's lane")
		}
		next.LaneID = parentLane
	} else if next.LaneID != cur.LaneID {
		var laneRoadmap int64
		err := tx.QueryRow(ctx,
			`SELECT roadmap_id FROM lanes WHERE id = $1`, next.LaneID).Scan(&laneRoadmap)
		if errors.Is(err, pgx.ErrNoRows) {
			return model.Item{}, invalidf("lane %d not found", next.LaneID)
		}
		if err != nil {
			return model.Item{}, err
		}
		if laneRoadmap != roadmapID {
			return model.Item{}, invalidf("lane %d belongs to a different roadmap", next.LaneID)
		}
	}

	// Maintain dense per-container ranks. On a container move (or explicit
	// rank change) the item is taken out of its old container's numbering
	// and spliced into the target position; siblings shift accordingly.
	containerChanged := next.LaneID != cur.LaneID || !ptrEq(next.ParentID, cur.ParentID)
	if containerChanged || p.Rank.Set {
		if _, err := tx.Exec(ctx,
			`UPDATE items SET rank = rank - 1, updated_at = now()
			 WHERE lane_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND rank > $3 AND id != $4`,
			cur.LaneID, cur.ParentID, cur.Rank, id); err != nil {
			return model.Item{}, err
		}
		var count int
		if err := tx.QueryRow(ctx,
			`SELECT COUNT(*) FROM items
			 WHERE lane_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND id != $3`,
			next.LaneID, next.ParentID, id).Scan(&count); err != nil {
			return model.Item{}, err
		}
		next.Rank = count // append by default
		if p.Rank.Set {
			next.Rank = max(0, min(p.Rank.Value, count))
		}
		if _, err := tx.Exec(ctx,
			`UPDATE items SET rank = rank + 1, updated_at = now()
			 WHERE lane_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND rank >= $3 AND id != $4`,
			next.LaneID, next.ParentID, next.Rank, id); err != nil {
			return model.Item{}, err
		}
	}

	row = tx.QueryRow(ctx,
		`UPDATE items SET lane_id = $2, parent_id = $3, title = $4, description = $5,
		        start_date = $6, end_date = $7, rank = $8, priority = $9, labels = $10,
		        flagged = $11, tentative = $12, at_risk = $13, updated_at = now()
		 WHERE id = $1
		 RETURNING `+itemCols,
		id, next.LaneID, next.ParentID, next.Title, next.Description,
		next.StartDate.Time, next.EndDate.Time, next.Rank, next.Priority, next.Labels,
		next.Flagged, next.Tentative, next.AtRisk)
	updated, err := scanItem(row)
	if err != nil {
		return model.Item{}, err
	}
	if updated.ParentID == nil && updated.LaneID != cur.LaneID {
		// Children follow their parent into the new lane.
		if _, err := tx.Exec(ctx,
			`UPDATE items SET lane_id = $2, updated_at = now() WHERE parent_id = $1`,
			id, updated.LaneID); err != nil {
			return model.Item{}, err
		}
	}
	return updated, tx.Commit(ctx)
}

func (s *Store) DeleteItem(ctx context.Context, id int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := s.lockRoadmapByItem(ctx, tx, id); err != nil {
		return err
	}

	var laneID, rank int64
	var parentID *int64
	err = tx.QueryRow(ctx,
		`DELETE FROM items WHERE id = $1 RETURNING lane_id, parent_id, rank`, id).
		Scan(&laneID, &parentID, &rank)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	// Keep the container's ranks dense.
	if _, err := tx.Exec(ctx,
		`UPDATE items SET rank = rank - 1, updated_at = now()
		 WHERE lane_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND rank > $3`,
		laneID, parentID, rank); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Milestones

type NewMilestone struct {
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Date        model.Date `json:"date"`
	Tentative   bool       `json:"tentative"`
	// Integration publishes the milestone for other roadmaps to mirror.
	Integration bool `json:"integration"`
	// SourceUID makes this a mirror of another roadmap's integration milestone.
	// Date and Tentative are then ignored (the source owns both) and an empty
	// Title adopts the source's.
	SourceUID string `json:"sourceUid"`
}

// CreateMilestone adds a milestone to a lane, or — when n names a source UID —
// a mirror of another roadmap's integration milestone.
func (s *Store) CreateMilestone(ctx context.Context, laneID int64, n NewMilestone) (model.Milestone, error) {
	if n.SourceUID != "" && n.Integration {
		return model.Milestone{}, invalidf("a mirror cannot itself be an integration milestone")
	}
	if n.SourceUID == "" {
		if n.Title == "" {
			return model.Milestone{}, invalidf("milestone title must not be empty")
		}
		if n.Date.IsZero() {
			return model.Milestone{}, invalidf("milestone date is required")
		}
	} else if !validUID(n.SourceUID) {
		return model.Milestone{}, invalidf("malformed source milestone identity %q", n.SourceUID)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Milestone{}, err
	}
	defer tx.Rollback(ctx)

	// Locking by lane also answers "does this lane exist, in a live roadmap",
	// which is what the plain existence check here used to do on its own.
	roadmapID, err := s.lockRoadmapByLane(ctx, tx, laneID)
	if err != nil {
		return model.Milestone{}, err
	}

	if n.Integration || n.SourceUID != "" {
		if err := checkPublicLink(ctx, tx, roadmapID); err != nil {
			return model.Milestone{}, err
		}
	}

	title, date, tentative := n.Title, n.Date.Time, n.Tentative
	var sourceUID *string
	if n.SourceUID != "" {
		src, err := resolveSource(ctx, tx, n.SourceUID)
		if err != nil {
			return model.Milestone{}, err
		}
		if src.RoadmapID == roadmapID {
			return model.Milestone{}, invalidf("a roadmap cannot mirror its own milestone")
		}
		mirrored, err := roadmapMirrors(ctx, tx, roadmapID, n.SourceUID)
		if err != nil {
			return model.Milestone{}, err
		}
		if mirrored {
			return model.Milestone{}, invalidf("this roadmap already mirrors %q", src.Title)
		}
		if strings.TrimSpace(title) == "" {
			title = src.Title
		}
		// Provider-owned: the date is only the cache a broken mirror falls back
		// to, and tentative is read from the source on every resolved read.
		date, tentative = src.Date.Time, false
		sourceUID = &n.SourceUID
	}
	m, err := scanMilestone(tx.QueryRow(ctx,
		`INSERT INTO milestones (lane_id, title, description, date, tentative, integration_milestone, source_milestone_uid)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::uuid) RETURNING `+milestoneCols,
		laneID, title, n.Description, date, tentative, n.Integration, sourceUID))
	if err != nil {
		return model.Milestone{}, err
	}
	return m, tx.Commit(ctx)
}

type MilestonePatch struct {
	Title       model.Opt[string]     `json:"title"`
	Description model.Opt[string]     `json:"description"`
	Date        model.Opt[model.Date] `json:"date"`
	Tentative   model.Opt[bool]       `json:"tentative"`
	Integration model.Opt[bool]       `json:"integration"`
}

// UpdateMilestone applies a patch. A mirror accepts only what its consuming
// roadmap owns, title and description; the source plans the rest. The source UID
// is not patchable at all — a mirror of another milestone is another mirror.
//
// Un-publishing and deleting a consumed milestone are both allowed, leaving
// broken mirrors behind; Linkage.UsedBy shows the owner that impact first.
func (s *Store) UpdateMilestone(ctx context.Context, id int64, p MilestonePatch) (model.Milestone, error) {
	if p.Title.Set && p.Title.Value == "" {
		return model.Milestone{}, invalidf("milestone title must not be empty")
	}
	if p.Date.Set && p.Date.Value.IsZero() {
		return model.Milestone{}, invalidf("milestone date must not be null")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Milestone{}, err
	}
	defer tx.Rollback(ctx)

	roadmapID, err := s.lockRoadmapByMilestone(ctx, tx, id)
	if err != nil {
		return model.Milestone{}, err
	}
	if p.Integration.Set && p.Integration.Value {
		if err := checkPublicLink(ctx, tx, roadmapID); err != nil {
			return model.Milestone{}, err
		}
	}
	mirror, err := isMirror(ctx, tx, id)
	if err != nil {
		return model.Milestone{}, err
	}
	if mirror {
		switch {
		case p.Date.Set:
			return model.Milestone{}, invalidf("a mirror is scheduled by the roadmap that owns its source milestone")
		case p.Tentative.Set:
			return model.Milestone{}, invalidf("a mirror's tentative state comes from its source milestone")
		case p.Integration.Set && p.Integration.Value:
			return model.Milestone{}, invalidf("a mirror cannot itself be an integration milestone")
		}
	}
	row := tx.QueryRow(ctx,
		`UPDATE milestones SET title = CASE WHEN $2 THEN $3 ELSE title END,
		        description = CASE WHEN $4 THEN $5 ELSE description END,
		        date = CASE WHEN $6 THEN $7 ELSE date END,
		        tentative = CASE WHEN $8 THEN $9 ELSE tentative END,
		        integration_milestone = CASE WHEN $10 THEN $11 ELSE integration_milestone END,
		        updated_at = now()
		 WHERE id = $1
		 RETURNING `+milestoneCols,
		id, p.Title.Set, p.Title.Value, p.Description.Set, p.Description.Value,
		p.Date.Set, p.Date.Value.Time, p.Tentative.Set, p.Tentative.Value,
		p.Integration.Set, p.Integration.Value)
	m, err := scanMilestone(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Milestone{}, ErrNotFound
	}
	if err != nil {
		return model.Milestone{}, err
	}
	if err := refreshMirrorCache(ctx, tx, roadmapID, m); err != nil {
		return model.Milestone{}, err
	}
	return m, tx.Commit(ctx)
}

func (s *Store) DeleteMilestone(ctx context.Context, id int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := s.lockRoadmapByMilestone(ctx, tx, id); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM milestones WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}
