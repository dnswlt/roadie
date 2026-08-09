package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/dnswlt/roadie/internal/model"
)

// Dependencies: directed edges between items and milestones of one roadmap,
// FROM the prerequisite TO the dependent ("to needs from"). This file enforces
// the graph invariants the schema cannot: both endpoints in the edge's own
// roadmap, no self-edges, no duplicates, and no cycles. All of it runs under
// the roadmap lock, which is what makes read-graph-then-insert safe: two
// concurrent inserts that are only cyclic together serialize on the lock, and
// the second one's check sees the first one's edge.

const depCols = "id, from_item_id, from_milestone_id, to_item_id, to_milestone_id"

func scanDependency(r rowScanner) (model.Dependency, error) {
	var d model.Dependency
	var fi, fm, ti, tm *int64
	if err := r.Scan(&d.ID, &fi, &fm, &ti, &tm); err != nil {
		return model.Dependency{}, err
	}
	d.From = refOf(fi, fm)
	d.To = refOf(ti, tm)
	return d, nil
}

// refOf rebuilds a DependencyRef from the two nullable endpoint columns of one
// side; the schema's CHECK guarantees exactly one is set.
func refOf(item, milestone *int64) model.DependencyRef {
	if item != nil {
		return model.DependencyRef{Kind: model.DepItem, ID: *item}
	}
	return model.DependencyRef{Kind: model.DepMilestone, ID: *milestone}
}

// refCols splits a DependencyRef into the two nullable endpoint columns of one
// side — the inverse of refOf. The caller has validated the kind.
func refCols(ref model.DependencyRef) (item, milestone *int64) {
	if ref.Kind == model.DepItem {
		return &ref.ID, nil
	}
	return nil, &ref.ID
}

func validDepKind(ref model.DependencyRef) error {
	if ref.Kind != model.DepItem && ref.Kind != model.DepMilestone {
		return invalidf("invalid dependency kind %q (want %q or %q)", ref.Kind, model.DepItem, model.DepMilestone)
	}
	return nil
}

// depsFromClause joins an edge to the lane of its from-endpoint. Both
// endpoints always share a roadmap (store-enforced), so scoping edges to a
// roadmap only needs one side.
const depsFromClause = `
	FROM dependencies d
	LEFT JOIN items fi ON fi.id = d.from_item_id
	LEFT JOIN milestones fm ON fm.id = d.from_milestone_id
	JOIN lanes l ON l.id = COALESCE(fi.lane_id, fm.lane_id)`

// getDependencies returns all dependency edges of a roadmap, ordered by id.
func getDependencies(ctx context.Context, q querier, roadmapID int64) ([]model.Dependency, error) {
	rows, err := q.Query(ctx,
		`SELECT d.id, d.from_item_id, d.from_milestone_id, d.to_item_id, d.to_milestone_id`+
			depsFromClause+` WHERE l.roadmap_id = $1 ORDER BY d.id`, roadmapID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []model.Dependency{}
	for rows.Next() {
		d, err := scanDependency(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, d)
	}
	return result, rows.Err()
}

func depEdges(deps []model.Dependency) []depEdge {
	edges := make([]depEdge, len(deps))
	for i, d := range deps {
		edges[i] = depEdge{from: nodeOf(d.From), to: nodeOf(d.To)}
	}
	return edges
}

// RoadmapIDByDependency returns the roadmap a dependency belongs to, or
// ErrNotFound — the resolver behind the DELETE route's authorization.
func (s *Store) RoadmapIDByDependency(ctx context.Context, depID int64) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx,
		`SELECT l.roadmap_id`+depsFromClause+` WHERE d.id = $1`, depID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return id, err
}

// lockRoadmapByDependency locks the roadmap owning depID and returns its id.
func (s *Store) lockRoadmapByDependency(ctx context.Context, tx pgx.Tx, depID int64) (int64, error) {
	var roadmapID int64
	err := tx.QueryRow(ctx,
		`SELECT l.roadmap_id`+depsFromClause+` WHERE d.id = $1`, depID).Scan(&roadmapID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	return roadmapID, s.lockRoadmap(ctx, tx, roadmapID)
}

// resolveDepRef validates that ref names an existing item or milestone and
// returns the roadmap it belongs to.
func resolveDepRef(ctx context.Context, q querier, ref model.DependencyRef) (int64, error) {
	var sql string
	switch ref.Kind {
	case model.DepItem:
		sql = `SELECT l.roadmap_id FROM items i JOIN lanes l ON l.id = i.lane_id WHERE i.id = $1`
	case model.DepMilestone:
		sql = `SELECT l.roadmap_id FROM milestones m JOIN lanes l ON l.id = m.lane_id WHERE m.id = $1`
	}
	var roadmapID int64
	err := q.QueryRow(ctx, sql, ref.ID).Scan(&roadmapID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, invalidf("%s %d not found", ref.Kind, ref.ID)
	}
	return roadmapID, err
}

// depLabels loads display labels for the given nodes, for diagnostics: items
// render as `"Title"`, milestones as `milestone "Title"`. Missing nodes (which
// the callers' validation makes impossible) fall back to `kind id`.
func depLabels(ctx context.Context, q querier, nodes []depNode) (map[depNode]string, error) {
	labels := make(map[depNode]string, len(nodes))
	var itemIDs, msIDs []int64
	for _, n := range nodes {
		if n.kind == model.DepItem {
			itemIDs = append(itemIDs, n.id)
		} else {
			msIDs = append(msIDs, n.id)
		}
		labels[n] = fmt.Sprintf("%s %d", n.kind, n.id) // fallback
	}
	load := func(sql string, ids []int64, kind, format string) error {
		if len(ids) == 0 {
			return nil
		}
		rows, err := q.Query(ctx, sql, ids)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			var title string
			if err := rows.Scan(&id, &title); err != nil {
				return err
			}
			labels[depNode{kind: kind, id: id}] = fmt.Sprintf(format, title)
		}
		return rows.Err()
	}
	if err := load(`SELECT id, title FROM items WHERE id = ANY($1)`, itemIDs, model.DepItem, "%q"); err != nil {
		return nil, err
	}
	if err := load(`SELECT id, title FROM milestones WHERE id = ANY($1)`, msIDs, model.DepMilestone, "milestone %q"); err != nil {
		return nil, err
	}
	return labels, nil
}

// needsChain renders a directed path (each node depended on by its successor)
// as `X needs Y` clauses, walked backwards so it reads from the dependent down
// to its root prerequisite. Also handles findCycle's closed paths (first node
// repeated at the end), where the walk naturally comes full circle.
func needsChain(path []depNode, labels map[depNode]string) string {
	var b strings.Builder
	for i := len(path) - 1; i > 0; i-- {
		if b.Len() > 0 {
			b.WriteString(", ")
		}
		fmt.Fprintf(&b, "%s needs %s", labels[path[i]], labels[path[i-1]])
	}
	return b.String()
}

// CreateDependency adds the edge "to depends on from" to roadmapID's graph.
// Rejections are ValidationErrors written for the person who caused them; the
// cycle message in particular names the existing chain that contradicts the
// request, since "would create a cycle" alone explains nothing.
func (s *Store) CreateDependency(ctx context.Context, roadmapID int64, from, to model.DependencyRef) (model.Dependency, error) {
	if err := validDepKind(from); err != nil {
		return model.Dependency{}, err
	}
	if err := validDepKind(to); err != nil {
		return model.Dependency{}, err
	}
	if from == to {
		article := "a"
		if from.Kind == model.DepItem {
			article = "an"
		}
		return model.Dependency{}, invalidf("%s %s cannot depend on itself", article, from.Kind)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return model.Dependency{}, err
	}
	defer tx.Rollback(ctx)

	if err := s.lockRoadmap(ctx, tx, roadmapID); err != nil {
		return model.Dependency{}, err
	}

	for _, ref := range []model.DependencyRef{from, to} {
		rid, err := resolveDepRef(ctx, tx, ref)
		if err != nil {
			return model.Dependency{}, err
		}
		if rid != roadmapID {
			return model.Dependency{}, invalidf("%s %d belongs to a different roadmap", ref.Kind, ref.ID)
		}
	}

	fi, fm := refCols(from)
	ti, tm := refCols(to)
	// Race-free without error-code sniffing: every mutation holds the roadmap
	// lock, so this pre-check cannot be invalidated before the insert commits.
	// The unique index remains as a backstop.
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM dependencies
		 WHERE from_item_id IS NOT DISTINCT FROM $1 AND from_milestone_id IS NOT DISTINCT FROM $2
		   AND to_item_id IS NOT DISTINCT FROM $3 AND to_milestone_id IS NOT DISTINCT FROM $4)`,
		fi, fm, ti, tm).Scan(&exists); err != nil {
		return model.Dependency{}, err
	}
	if exists {
		return model.Dependency{}, invalidf("this dependency already exists")
	}

	deps, err := getDependencies(ctx, tx, roadmapID)
	if err != nil {
		return model.Dependency{}, err
	}
	// Adding from→to creates a cycle iff `from` is already reachable from `to`
	// — i.e. `from` transitively depends on `to`. The found path is the
	// diagnostic: it names the chain the user is contradicting.
	if path := findPath(depEdges(deps), nodeOf(to), nodeOf(from)); path != nil {
		labels, err := depLabels(ctx, tx, path)
		if err != nil {
			return model.Dependency{}, err
		}
		msg := fmt.Sprintf("would create a dependency cycle: %s already depends on %s",
			labels[nodeOf(from)], labels[nodeOf(to)])
		if len(path) > 2 { // indirect: spell out the chain
			msg += fmt.Sprintf(" (%s)", needsChain(path, labels))
		}
		return model.Dependency{}, invalidf("%s", msg)
	}

	d, err := scanDependency(tx.QueryRow(ctx,
		`INSERT INTO dependencies (from_item_id, from_milestone_id, to_item_id, to_milestone_id)
		 VALUES ($1, $2, $3, $4) RETURNING `+depCols, fi, fm, ti, tm))
	if err != nil {
		return model.Dependency{}, err
	}
	return d, tx.Commit(ctx)
}

// DeleteDependency removes one edge.
func (s *Store) DeleteDependency(ctx context.Context, id int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := s.lockRoadmapByDependency(ctx, tx, id); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM dependencies WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// insertDependencies validates and writes src's dependency edges into a fresh
// import/restore target, within tx. Edges reference the ids embedded in src;
// itemIDs/msIDs map them to the freshly assigned rows. Unknown references and
// cycles are rejected — the store enforces the DAG on every path, not just the
// API one — while exact duplicate edges are silently collapsed (the same edge
// twice is still one edge). Called by insertRoadmapContents.
func insertDependencies(ctx context.Context, tx pgx.Tx, src model.RoadmapFull, itemIDs, msIDs map[int64]int64) error {
	if len(src.Dependencies) == 0 {
		return nil
	}
	// Labels come from the source payload itself: at this point the fresh rows
	// exist but diagnostics should speak in the file's own terms.
	labels := map[depNode]string{}
	for _, lane := range src.Lanes {
		for _, it := range lane.Items {
			labels[depNode{kind: model.DepItem, id: it.ID}] = fmt.Sprintf("%q", it.Title)
			for _, c := range it.Children {
				labels[depNode{kind: model.DepItem, id: c.ID}] = fmt.Sprintf("%q", c.Title)
			}
		}
		for _, ms := range lane.Milestones {
			labels[depNode{kind: model.DepMilestone, id: ms.ID}] = fmt.Sprintf("milestone %q", ms.Title)
		}
	}

	remap := func(ref model.DependencyRef) (model.DependencyRef, error) {
		if err := validDepKind(ref); err != nil {
			return model.DependencyRef{}, err
		}
		ids := itemIDs
		if ref.Kind == model.DepMilestone {
			ids = msIDs
		}
		newID, ok := ids[ref.ID]
		if !ok {
			return model.DependencyRef{}, invalidf("dependency references unknown %s %d", ref.Kind, ref.ID)
		}
		return model.DependencyRef{Kind: ref.Kind, ID: newID}, nil
	}

	// Validate the whole set first (the graph must be a DAG as a whole — there
	// is no single new edge to blame here), then insert.
	type edgeKey struct{ from, to depNode }
	seen := map[edgeKey]bool{}
	var edges []depEdge
	type row struct{ fi, fm, ti, tm *int64 }
	var rows []row
	for _, d := range src.Dependencies {
		if d.From == d.To {
			return invalidf("dependency of %s on itself", labels[nodeOf(d.From)])
		}
		from, err := remap(d.From)
		if err != nil {
			return err
		}
		to, err := remap(d.To)
		if err != nil {
			return err
		}
		key := edgeKey{from: nodeOf(d.From), to: nodeOf(d.To)}
		if seen[key] {
			continue
		}
		seen[key] = true
		edges = append(edges, depEdge{from: nodeOf(d.From), to: nodeOf(d.To)})
		fi, fm := refCols(from)
		ti, tm := refCols(to)
		rows = append(rows, row{fi, fm, ti, tm})
	}
	if cycle := findCycle(edges); cycle != nil {
		return invalidf("dependencies contain a cycle: %s", needsChain(cycle, labels))
	}
	for _, r := range rows {
		if _, err := tx.Exec(ctx,
			`INSERT INTO dependencies (from_item_id, from_milestone_id, to_item_id, to_milestone_id)
			 VALUES ($1, $2, $3, $4)`, r.fi, r.fm, r.ti, r.tm); err != nil {
			return err
		}
	}
	return nil
}
