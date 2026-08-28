package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dnswlt/roadie/internal/model"
)

// Integration milestones and mirrors (notes/external_milestones.md).
//
// A consuming roadmap represents another roadmap's published milestone with a
// local *mirror* row, so every stored dependency still has both endpoints in
// one roadmap. What the provider owns — date, tentative, its own wording — is
// resolved at read time, never copied into the consumer.
//
// Two rules govern this file:
//
//   - Creating a link needs both roadmaps public. That is why nothing here
//     takes a viewer: every answer is a fact about the world, not about the
//     caller. A later flip is never blocked, so existing mirrors of a public
//     source keep resolving into a roadmap that has since gone private, and
//     that roadmap drops out of the source's usage count — the provider can
//     only be shown consumers it may name.
//   - Resolution may fail and must never fail the read. A source that is
//     deleted, unpublished, private or trashed leaves a broken mirror, which
//     keeps its cached date and its dependencies.

// sourceRef is a resolved source milestone: the provider row a mirror stands
// for, with the roadmap that owns it.
type sourceRef struct {
	model.MirrorSource
	Date      model.Date
	Tentative bool
}

// sourceCols are the provider-side columns every resolution reads, over
// `milestones ms` joined to `lanes l` and `roadmaps`.
const sourceCols = `ms.id, ms.title, ms.date, ms.tentative, roadmaps.id, roadmaps.name`

func scanSource(r rowScanner) (sourceRef, error) {
	var src sourceRef
	var date time.Time
	err := r.Scan(&src.MilestoneID, &src.Title, &date, &src.Tentative,
		&src.RoadmapID, &src.RoadmapName)
	if err != nil {
		return sourceRef{}, err
	}
	src.Date = model.NewDate(date)
	return src, nil
}

// sourceFrom is the join every resolution shares: a published milestone of a
// live, public roadmap. A trashed or private provider resolves to nothing,
// which is the same answer a deleted one gives and needs no separate handling.
const sourceFrom = `FROM milestones ms
	 JOIN lanes l ON l.id = ms.lane_id
	 JOIN roadmaps ON roadmaps.id = l.roadmap_id
	 WHERE ms.integration_milestone AND roadmaps.deleted_at IS NULL
	   AND roadmaps.visibility = 'public'`

// resolveSource returns the integration milestone uid names. Rejection is a
// ValidationError, not ErrNotFound: the request named the source, so its absence
// is a fact about that request rather than a missing route.
func resolveSource(ctx context.Context, q querier, uid string) (sourceRef, error) {
	src, err := scanSource(q.QueryRow(ctx,
		`SELECT `+sourceCols+` `+sourceFrom+` AND ms.uid = $1::uuid`, uid))
	if errors.Is(err, pgx.ErrNoRows) {
		return sourceRef{}, invalidf("no integration milestone with identity %s is available here", uid)
	}
	return src, err
}

// roadmapMirrors reports whether roadmapID already holds a mirror of uid: at
// most one is allowed per source. Milestones carry a lane rather than a roadmap,
// so no unique index can serve this; the check runs under the roadmap lock.
func roadmapMirrors(ctx context.Context, q querier, roadmapID int64, uid string) (bool, error) {
	var exists bool
	err := q.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM milestones ms JOIN lanes l ON l.id = ms.lane_id
		 WHERE l.roadmap_id = $1 AND ms.source_milestone_uid = $2::uuid)`,
		roadmapID, uid).Scan(&exists)
	return exists, err
}

// roadmapIsPublic reports whether a roadmap may take part in cross-roadmap
// links at all — as provider or as consumer. A roadmap that does not exist is
// not public, which is the only answer any caller here needs.
func roadmapIsPublic(ctx context.Context, q querier, roadmapID int64) (bool, error) {
	var public bool
	err := q.QueryRow(ctx,
		`SELECT visibility = 'public' FROM roadmaps WHERE id = $1`, roadmapID).Scan(&public)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return public, err
}

// isMirror reports whether a milestone is a mirror rather than one this
// roadmap plans.
func isMirror(ctx context.Context, q querier, milestoneID int64) (bool, error) {
	var mirror bool
	err := q.QueryRow(ctx,
		`SELECT source_milestone_uid IS NOT NULL FROM milestones WHERE id = $1`, milestoneID).Scan(&mirror)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrNotFound
	}
	return mirror, err
}

// mirrorSourceOf returns the source UID of a mirror, or "" if the milestone is
// not one.
func mirrorSourceOf(ctx context.Context, q querier, milestoneID int64) (string, error) {
	var uid *string
	err := q.QueryRow(ctx,
		`SELECT source_milestone_uid FROM milestones WHERE id = $1`, milestoneID).Scan(&uid)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil || uid == nil {
		return "", err
	}
	return *uid, nil
}

// refreshMirrorCache pushes a public integration milestone's date out to its
// mirrors, so a mirror that later breaks has a recent fallback. This cache is
// deliberately best-effort: the update takes row locks, not every consumer's
// roadmap lock, and a concurrent restore may reinstate an older value.
// updated_at stays put — the provider changed, not the mirror.
func refreshMirrorCache(ctx context.Context, tx pgx.Tx, roadmapID int64, src model.Milestone) error {
	if !src.IsIntegration() {
		return nil
	}
	public, err := roadmapIsPublic(ctx, tx, roadmapID)
	if err != nil || !public {
		return err
	}
	_, err = tx.Exec(ctx,
		`UPDATE milestones SET date = $2 WHERE source_milestone_uid = $1::uuid AND date <> $2`,
		src.UID, src.Date.Time)
	return err
}

// ResolveMirrors fills in the derived halves of a roadmap's milestones in place:
// each mirror's provider side, and each integration milestone's usage count.
//
// Request-scoped reads only. Export, duplication and snapshot capture skip it,
// so they persist stored state and nothing derived — as with Roadmap.Owned.
func (s *Store) ResolveMirrors(ctx context.Context, full *model.RoadmapFull) error {
	var sourceUIDs, publishedUIDs []string
	for _, lane := range full.Lanes {
		for _, ms := range lane.Milestones {
			switch {
			case ms.IsMirror():
				sourceUIDs = append(sourceUIDs, ms.Linkage.SourceUID)
			case ms.IsIntegration():
				publishedUIDs = append(publishedUIDs, ms.UID)
			}
		}
	}
	sources, err := resolveSources(ctx, s.pool, sourceUIDs)
	if err != nil {
		return err
	}
	usage, err := mirrorUsage(ctx, s.pool, publishedUIDs)
	if err != nil {
		return err
	}
	for li := range full.Lanes {
		for mi := range full.Lanes[li].Milestones {
			ms := &full.Lanes[li].Milestones[mi]
			switch {
			case ms.IsMirror():
				// A source that does not resolve leaves Source nil, which is
				// the broken mirror: the row keeps its cached date and its
				// dependencies, and the consumer is shown that it is stale.
				src, ok := sources[ms.Linkage.SourceUID]
				if !ok {
					continue
				}
				source := src.MirrorSource
				ms.Linkage.Source = &source
				// The provider owns these two, so a resolved read reports its
				// current values rather than the mirror's cache.
				ms.Date, ms.Tentative = src.Date, src.Tentative
			case ms.IsIntegration():
				ms.Linkage.UsedBy = usage[ms.UID]
			}
		}
	}
	return nil
}

// resolveSources resolves several source UIDs at once, keyed by UID. A UID that
// names nothing published is absent from the result.
func resolveSources(ctx context.Context, q querier, uids []string) (map[string]sourceRef, error) {
	out := map[string]sourceRef{}
	if len(uids) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx,
		`SELECT ms.uid, `+sourceCols+` `+sourceFrom+` AND ms.uid = ANY($1::uuid[])`, uids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var uid string
		var src sourceRef
		var date time.Time
		if err := rows.Scan(&uid, &src.MilestoneID, &src.Title, &date,
			&src.Tentative, &src.RoadmapID, &src.RoadmapName); err != nil {
			return nil, err
		}
		src.Date = model.NewDate(date)
		out[uid] = src
	}
	return out, rows.Err()
}

// mirrorUsage counts, per published milestone UID, the live public roadmaps
// holding a mirror of it — carried, not depended on: deleting the source breaks
// a mirror either way.
func mirrorUsage(ctx context.Context, q querier, uids []string) (map[string]int, error) {
	out := map[string]int{}
	if len(uids) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx,
		`SELECT mir.source_milestone_uid, count(DISTINCT l.roadmap_id)
		 FROM milestones mir
		 JOIN lanes l ON l.id = mir.lane_id
		 JOIN roadmaps r ON r.id = l.roadmap_id
		 WHERE mir.source_milestone_uid = ANY($1::uuid[])
		   AND r.deleted_at IS NULL AND r.visibility = 'public'
		 GROUP BY mir.source_milestone_uid`, uids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var uid string
		var n int
		if err := rows.Scan(&uid, &n); err != nil {
			return nil, err
		}
		out[uid] = n
	}
	return out, rows.Err()
}

// ListIntegrationMilestones returns what roadmapID could mirror, ordered by
// roadmap name then date. Sources it already mirrors are flagged rather than
// dropped, so the picker can say why one cannot be chosen twice. A private
// roadmap gets an empty list: it may not consume either.
func (s *Store) ListIntegrationMilestones(ctx context.Context, roadmapID int64) ([]model.IntegrationMilestone, error) {
	public, err := roadmapIsPublic(ctx, s.pool, roadmapID)
	if err != nil || !public {
		return []model.IntegrationMilestone{}, err
	}
	rows, err := s.pool.Query(ctx,
		`SELECT ms.uid, ms.title, ms.description, ms.date, ms.tentative, roadmaps.id, roadmaps.name,
		        EXISTS (SELECT 1 FROM milestones mir JOIN lanes ml ON ml.id = mir.lane_id
		                WHERE ml.roadmap_id = $1 AND mir.source_milestone_uid = ms.uid)
		 `+sourceFrom+` AND roadmaps.id <> $1
		 ORDER BY roadmaps.name, ms.date, ms.title`, roadmapID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.IntegrationMilestone{}
	for rows.Next() {
		var im model.IntegrationMilestone
		var date time.Time
		if err := rows.Scan(&im.UID, &im.Title, &im.Description, &date, &im.Tentative,
			&im.RoadmapID, &im.RoadmapName, &im.Mirrored); err != nil {
			return nil, err
		}
		im.Date = model.NewDate(date)
		out = append(out, im)
	}
	return out, rows.Err()
}
