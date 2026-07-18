// Package store provides Postgres persistence for the roadmap model and
// enforces its invariants: item nesting is at most one level deep, and a
// child item always lives in the same lane as its parent.
package store

import (
	"context"
	"errors"
	"fmt"
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

const itemCols = "id, lane_id, parent_id, title, description, start_date, end_date, updated_at"

func scanItem(r rowScanner) (model.Item, error) {
	var it model.Item
	var start, end time.Time
	err := r.Scan(&it.ID, &it.LaneID, &it.ParentID, &it.Title, &it.Description,
		&start, &end, &it.UpdatedAt)
	if err != nil {
		return model.Item{}, err
	}
	it.StartDate = model.NewDate(start)
	it.EndDate = model.NewDate(end)
	return it, nil
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
		`SELECT id, roadmap_id, name, position FROM lanes WHERE roadmap_id = $1 ORDER BY position, id`, id)
	if err != nil {
		return full, err
	}
	defer laneRows.Close()
	full.Lanes = []model.LaneFull{}
	laneIdx := map[int64]int{}
	for laneRows.Next() {
		var l model.Lane
		if err := laneRows.Scan(&l.ID, &l.RoadmapID, &l.Name, &l.Position); err != nil {
			return full, err
		}
		laneIdx[l.ID] = len(full.Lanes)
		full.Lanes = append(full.Lanes, model.LaneFull{Lane: l, Items: []model.ItemFull{}})
	}
	if err := laneRows.Err(); err != nil {
		return full, err
	}

	itemRows, err := s.pool.Query(ctx,
		`SELECT `+itemCols+` FROM items
		 WHERE lane_id IN (SELECT id FROM lanes WHERE roadmap_id = $1)
		 ORDER BY start_date, id`, id)
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
	return full, nil
}

// Lanes

func (s *Store) CreateLane(ctx context.Context, roadmapID int64, name string) (model.Lane, error) {
	if name == "" {
		return model.Lane{}, invalidf("lane name must not be empty")
	}
	var l model.Lane
	err := s.pool.QueryRow(ctx,
		`INSERT INTO lanes (roadmap_id, name, position)
		 SELECT r.id, $2, (SELECT COALESCE(MAX(position) + 1, 0) FROM lanes WHERE roadmap_id = $1)
		 FROM roadmaps r WHERE r.id = $1
		 RETURNING id, roadmap_id, name, position`,
		roadmapID, name).Scan(&l.ID, &l.RoadmapID, &l.Name, &l.Position)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Lane{}, ErrNotFound
	}
	return l, err
}

func (s *Store) RenameLane(ctx context.Context, id int64, name string) (model.Lane, error) {
	if name == "" {
		return model.Lane{}, invalidf("lane name must not be empty")
	}
	var l model.Lane
	err := s.pool.QueryRow(ctx,
		`UPDATE lanes SET name = $2, updated_at = now() WHERE id = $1
		 RETURNING id, roadmap_id, name, position`,
		id, name).Scan(&l.ID, &l.RoadmapID, &l.Name, &l.Position)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Lane{}, ErrNotFound
	}
	return l, err
}

func (s *Store) DeleteLane(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM lanes WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ReorderLanes sets the lane order of a roadmap. laneIDs must contain exactly
// the IDs of the roadmap's lanes, in the desired order.
func (s *Store) ReorderLanes(ctx context.Context, roadmapID int64, laneIDs []int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx,
		`SELECT id FROM lanes WHERE roadmap_id = $1 FOR UPDATE`, roadmapID)
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

	if n.ParentID != nil {
		var parentLane int64
		var grandparent *int64
		err := tx.QueryRow(ctx,
			`SELECT lane_id, parent_id FROM items WHERE id = $1`, *n.ParentID).
			Scan(&parentLane, &grandparent)
		if errors.Is(err, pgx.ErrNoRows) {
			return model.Item{}, invalidf("parent item %d not found", *n.ParentID)
		}
		if err != nil {
			return model.Item{}, err
		}
		if grandparent != nil {
			return model.Item{}, invalidf("items can only be nested one level deep")
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

	row := tx.QueryRow(ctx,
		`INSERT INTO items (lane_id, parent_id, title, description, start_date, end_date)
		 VALUES ($1, $2, $3, $4, $5, $6)
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
}

// UpdateItem applies a partial update. Moves (lane change, reparenting) go
// through here as well; children follow their parent's lane automatically.
func (s *Store) UpdateItem(ctx context.Context, id int64, p ItemPatch) (model.Item, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Item{}, err
	}
	defer tx.Rollback(ctx)

	row := tx.QueryRow(ctx, `SELECT `+itemCols+` FROM items WHERE id = $1 FOR UPDATE`, id)
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

	if next.Title == "" {
		return model.Item{}, invalidf("item title must not be empty")
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
		var parentLane int64
		var grandparent *int64
		err := tx.QueryRow(ctx,
			`SELECT lane_id, parent_id FROM items WHERE id = $1 FOR UPDATE`, pid).
			Scan(&parentLane, &grandparent)
		if errors.Is(err, pgx.ErrNoRows) {
			return model.Item{}, invalidf("parent item %d not found", pid)
		}
		if err != nil {
			return model.Item{}, err
		}
		if grandparent != nil {
			return model.Item{}, invalidf("items can only be nested one level deep")
		}
		if p.LaneID.Set && p.LaneID.Value != parentLane {
			return model.Item{}, invalidf("child items inherit their parent's lane")
		}
		next.LaneID = parentLane
	} else if next.LaneID != cur.LaneID {
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM lanes WHERE id = $1)`, next.LaneID).Scan(&exists); err != nil {
			return model.Item{}, err
		}
		if !exists {
			return model.Item{}, invalidf("lane %d not found", next.LaneID)
		}
	}

	row = tx.QueryRow(ctx,
		`UPDATE items SET lane_id = $2, parent_id = $3, title = $4, description = $5,
		        start_date = $6, end_date = $7, updated_at = now()
		 WHERE id = $1
		 RETURNING `+itemCols,
		id, next.LaneID, next.ParentID, next.Title, next.Description,
		next.StartDate.Time, next.EndDate.Time)
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
	tag, err := s.pool.Exec(ctx, `DELETE FROM items WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
