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

func (s *Store) lockRoadmap(ctx context.Context, tx pgx.Tx, roadmapID int64) error {
	var dummy int64
	err := tx.QueryRow(ctx, `SELECT id FROM roadmaps WHERE id = $1 FOR UPDATE`, roadmapID).Scan(&dummy)
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

type rowScanner interface {
	Scan(dest ...any) error
}

const itemCols = "id, lane_id, parent_id, title, description, start_date, end_date, rank, priority, labels, updated_at"

func scanItem(r rowScanner) (model.Item, error) {
	var it model.Item
	var start, end time.Time
	err := r.Scan(&it.ID, &it.LaneID, &it.ParentID, &it.Title, &it.Description,
		&start, &end, &it.Rank, &it.Priority, &it.Labels, &it.UpdatedAt)
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

const milestoneCols = "id, lane_id, title, description, date, updated_at"

func scanMilestone(r rowScanner) (model.Milestone, error) {
	var m model.Milestone
	var date time.Time
	if err := r.Scan(&m.ID, &m.LaneID, &m.Title, &m.Description, &date, &m.UpdatedAt); err != nil {
		return model.Milestone{}, err
	}
	m.Date = model.NewDate(date)
	return m, nil
}

// Roadmaps

func (s *Store) ListRoadmaps(ctx context.Context) ([]model.Roadmap, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, name, created_at, updated_at FROM roadmaps ORDER BY name, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []model.Roadmap{}
	for rows.Next() {
		var r model.Roadmap
		if err := rows.Scan(&r.ID, &r.Name, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

func (s *Store) CreateRoadmap(ctx context.Context, name string) (model.Roadmap, error) {
	if name == "" {
		return model.Roadmap{}, invalidf("roadmap name must not be empty")
	}
	var r model.Roadmap
	err := s.pool.QueryRow(ctx,
		`INSERT INTO roadmaps (name) VALUES ($1) RETURNING id, name, created_at, updated_at`,
		name).Scan(&r.ID, &r.Name, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}

func (s *Store) RenameRoadmap(ctx context.Context, id int64, name string) (model.Roadmap, error) {
	if name == "" {
		return model.Roadmap{}, invalidf("roadmap name must not be empty")
	}
	var r model.Roadmap
	err := s.pool.QueryRow(ctx,
		`UPDATE roadmaps SET name = $2, updated_at = now() WHERE id = $1
		 RETURNING id, name, created_at, updated_at`,
		id, name).Scan(&r.ID, &r.Name, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Roadmap{}, ErrNotFound
	}
	return r, err
}

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
// by position, items (and children) ordered by start date.
func (s *Store) GetRoadmapFull(ctx context.Context, id int64) (model.RoadmapFull, error) {
	var full model.RoadmapFull
	err := s.pool.QueryRow(ctx,
		`SELECT id, name, created_at, updated_at FROM roadmaps WHERE id = $1`, id).
		Scan(&full.ID, &full.Name, &full.CreatedAt, &full.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return full, ErrNotFound
	}
	if err != nil {
		return full, err
	}

	laneRows, err := s.pool.Query(ctx,
		`SELECT id, roadmap_id, name, position, color FROM lanes WHERE roadmap_id = $1 ORDER BY position, id`, id)
	if err != nil {
		return full, err
	}
	defer laneRows.Close()
	full.Lanes = []model.LaneFull{}
	laneIdx := map[int64]int{}
	for laneRows.Next() {
		var l model.Lane
		if err := laneRows.Scan(&l.ID, &l.RoadmapID, &l.Name, &l.Position, &l.Color); err != nil {
			return full, err
		}
		laneIdx[l.ID] = len(full.Lanes)
		full.Lanes = append(full.Lanes, model.LaneFull{
			Lane: l, Items: []model.ItemFull{}, Milestones: []model.Milestone{}})
	}
	if err := laneRows.Err(); err != nil {
		return full, err
	}

	itemRows, err := s.pool.Query(ctx,
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

	msRows, err := s.pool.Query(ctx,
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
	return full, nil
}

// Lanes

// laneColors are the color themes a swimlane can use; they are also
// auto-assigned round-robin when lanes are created.
var laneColors = []string{"blue", "green", "red", "orange", "purple"}

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

	var l model.Lane
	err = tx.QueryRow(ctx,
		`WITH pos AS (SELECT COALESCE(MAX(position) + 1, 0) AS p FROM lanes WHERE roadmap_id = $1)
		 INSERT INTO lanes (roadmap_id, name, position, color)
		 SELECT r.id, $2, pos.p, (ARRAY['blue','green','red','orange','purple'])[(pos.p % 5) + 1]
		 FROM roadmaps r, pos WHERE r.id = $1
		 RETURNING id, roadmap_id, name, position, color`,
		roadmapID, name).Scan(&l.ID, &l.RoadmapID, &l.Name, &l.Position, &l.Color)
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

	var l model.Lane
	err = tx.QueryRow(ctx,
		`UPDATE lanes SET name = CASE WHEN $2 THEN $3 ELSE name END,
		        color = CASE WHEN $4 THEN $5 ELSE color END,
		        updated_at = now()
		 WHERE id = $1
		 RETURNING id, roadmap_id, name, position, color`,
		id, p.Name.Set, p.Name.Value, p.Color.Set, p.Color.Value).
		Scan(&l.ID, &l.RoadmapID, &l.Name, &l.Position, &l.Color)
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

	// New items are appended to their container (lane for top-level items,
	// parent for children). Ranks are kept dense per container.
	row := tx.QueryRow(ctx,
		`INSERT INTO items (lane_id, parent_id, title, description, start_date, end_date, rank)
		 VALUES ($1, $2, $3, $4, $5, $6,
		         (SELECT COUNT(*) FROM items WHERE lane_id = $1 AND parent_id IS NOT DISTINCT FROM $2))
		 RETURNING `+itemCols,
		laneID, n.ParentID, n.Title, n.Description, n.StartDate.Time, n.EndDate.Time)
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
		        updated_at = now()
		 WHERE id = $1
		 RETURNING `+itemCols,
		id, next.LaneID, next.ParentID, next.Title, next.Description,
		next.StartDate.Time, next.EndDate.Time, next.Rank, next.Priority, next.Labels)
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
}

func (s *Store) CreateMilestone(ctx context.Context, laneID int64, n NewMilestone) (model.Milestone, error) {
	if n.Title == "" {
		return model.Milestone{}, invalidf("milestone title must not be empty")
	}
	if n.Date.IsZero() {
		return model.Milestone{}, invalidf("milestone date is required")
	}
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM lanes WHERE id = $1)`, laneID).Scan(&exists); err != nil {
		return model.Milestone{}, err
	}
	if !exists {
		return model.Milestone{}, ErrNotFound
	}
	row := s.pool.QueryRow(ctx,
		`INSERT INTO milestones (lane_id, title, description, date)
		 VALUES ($1, $2, $3, $4) RETURNING `+milestoneCols,
		laneID, n.Title, n.Description, n.Date.Time)
	return scanMilestone(row)
}

type MilestonePatch struct {
	Title       model.Opt[string]     `json:"title"`
	Description model.Opt[string]     `json:"description"`
	Date        model.Opt[model.Date] `json:"date"`
}

func (s *Store) UpdateMilestone(ctx context.Context, id int64, p MilestonePatch) (model.Milestone, error) {
	if p.Title.Set && p.Title.Value == "" {
		return model.Milestone{}, invalidf("milestone title must not be empty")
	}
	if p.Date.Set && p.Date.Value.IsZero() {
		return model.Milestone{}, invalidf("milestone date must not be null")
	}
	row := s.pool.QueryRow(ctx,
		`UPDATE milestones SET title = CASE WHEN $2 THEN $3 ELSE title END,
		        description = CASE WHEN $4 THEN $5 ELSE description END,
		        date = CASE WHEN $6 THEN $7 ELSE date END,
		        updated_at = now()
		 WHERE id = $1
		 RETURNING `+milestoneCols,
		id, p.Title.Set, p.Title.Value, p.Description.Set, p.Description.Value,
		p.Date.Set, p.Date.Value.Time)
	m, err := scanMilestone(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Milestone{}, ErrNotFound
	}
	return m, err
}

func (s *Store) DeleteMilestone(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM milestones WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
