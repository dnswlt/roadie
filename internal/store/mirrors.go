package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dnswlt/roadie/internal/model"
)

// Integration milestones and mirrors (notes/external_milestones.md).
//
// A consuming roadmap represents another roadmap's published milestone with a
// local *mirror* row, so every stored dependency still has both endpoints in
// one roadmap. What the provider owns — date and planning signals — is resolved
// at read time, never copied into the consumer.
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
	AtRisk    bool
}

// applyResolvedSource projects the provider-owned part of a mirror onto a
// response. The mirror row remains the durable cache; none of these derived
// values are written back here.
func applyResolvedSource(m *model.Milestone, src sourceRef) {
	source := src.MirrorSource
	m.Linkage.Source = &source
	m.Date, m.Tentative, m.AtRisk = src.Date, src.Tentative, src.AtRisk
}

func applyConsumers(m *model.Milestone, consumers []model.MirrorConsumer) {
	m.Linkage.Consumers = consumers
	m.Linkage.UsedBy = len(consumers)
}

// resolveMilestone fills the derived linkage fields on a mutation response.
// An unavailable mirror source is a valid broken link, just as it is when a
// whole roadmap is resolved, so absence leaves the stored fallback untouched.
func resolveMilestone(ctx context.Context, q querier, m *model.Milestone) error {
	switch {
	case m.IsMirror():
		sources, err := resolveSources(ctx, q, []string{m.Linkage.SourceUID})
		if err != nil {
			return err
		}
		if src, ok := sources[m.Linkage.SourceUID]; ok {
			applyResolvedSource(m, src)
		}
	case m.IsIntegration():
		consumers, err := mirrorConsumers(ctx, q, []string{m.UID})
		if err != nil {
			return err
		}
		applyConsumers(m, consumers[m.UID])
	}
	return nil
}

// sourceCols are the provider-side columns every resolution reads, over
// `milestones ms` joined to `lanes l` and `roadmaps`.
const sourceCols = `ms.id, ms.title, ms.date, ms.tentative, ms.at_risk, roadmaps.id, roadmaps.name`

func scanSource(r rowScanner) (sourceRef, error) {
	var src sourceRef
	var date time.Time
	err := r.Scan(&src.MilestoneID, &src.Title, &date, &src.Tentative, &src.AtRisk,
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
// each mirror's provider side, and each integration milestone's consumers.
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
	consumers, err := mirrorConsumers(ctx, s.pool, publishedUIDs)
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
				applyResolvedSource(ms, src)
			case ms.IsIntegration():
				applyConsumers(ms, consumers[ms.UID])
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
			&src.Tentative, &src.AtRisk, &src.RoadmapID, &src.RoadmapName); err != nil {
			return nil, err
		}
		src.Date = model.NewDate(date)
		out[uid] = src
	}
	return out, rows.Err()
}

// mirrorConsumers lists, per published milestone UID, the mirrors held by live
// public roadmaps. A bare mirror counts: deleting the source breaks it whether
// or not the consumer has attached a dependency yet.
func mirrorConsumers(ctx context.Context, q querier, uids []string) (map[string][]model.MirrorConsumer, error) {
	out := map[string][]model.MirrorConsumer{}
	if len(uids) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx,
		`SELECT mir.source_milestone_uid, r.id, r.name, mir.id, mir.title
		 FROM milestones mir
		 JOIN lanes l ON l.id = mir.lane_id
		 JOIN roadmaps r ON r.id = l.roadmap_id
		 WHERE mir.source_milestone_uid = ANY($1::uuid[])
		   AND r.deleted_at IS NULL AND r.visibility = 'public'
		 ORDER BY mir.source_milestone_uid, lower(r.name), r.name, mir.id`, uids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var uid string
		var consumer model.MirrorConsumer
		if err := rows.Scan(&uid, &consumer.RoadmapID, &consumer.RoadmapName,
			&consumer.MilestoneID, &consumer.Title); err != nil {
			return nil, err
		}
		out[uid] = append(out[uid], consumer)
	}
	return out, rows.Err()
}

const integrationMilestoneSearchLimit = 50

// SearchIntegrationMilestones returns at most 50 sources matching every
// whitespace-separated query term across milestone title, roadmap name and
// description. It returns only sources roadmapID may still mirror, so existing
// mirrors neither occupy result slots nor need client-side filtering.
func (s *Store) SearchIntegrationMilestones(ctx context.Context, roadmapID int64, query string) ([]model.IntegrationMilestone, error) {
	public, err := roadmapIsPublic(ctx, s.pool, roadmapID)
	if err != nil || !public {
		return []model.IntegrationMilestone{}, err
	}
	terms := strings.Fields(strings.ToLower(query))
	if len(terms) == 0 {
		return []model.IntegrationMilestone{}, nil
	}
	rows, err := s.pool.Query(ctx,
		`SELECT ms.uid, ms.title, ms.description, ms.date, ms.tentative, ms.at_risk, roadmaps.id, roadmaps.name
		 `+sourceFrom+` AND roadmaps.id <> $1
		   AND NOT EXISTS (
		       SELECT 1 FROM milestones mir JOIN lanes ml ON ml.id = mir.lane_id
		       WHERE ml.roadmap_id = $1 AND mir.source_milestone_uid = ms.uid)
		   AND NOT EXISTS (
		       SELECT 1 FROM unnest($2::text[]) AS q(term)
		       WHERE strpos(lower(concat_ws(E'\n', ms.title, roadmaps.name, ms.description)), q.term) = 0)
		 ORDER BY roadmaps.name, ms.date, ms.title
		 LIMIT $3`, roadmapID, terms, integrationMilestoneSearchLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.IntegrationMilestone{}
	for rows.Next() {
		var im model.IntegrationMilestone
		var date time.Time
		if err := rows.Scan(&im.UID, &im.Title, &im.Description, &date, &im.Tentative, &im.AtRisk,
			&im.RoadmapID, &im.RoadmapName); err != nil {
			return nil, err
		}
		im.Date = model.NewDate(date)
		out = append(out, im)
	}
	return out, rows.Err()
}
