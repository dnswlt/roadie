package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/dnswlt/roadie/internal/model"
)

// Roadmap visibility and membership.
//
// The whole access model is one predicate — visibleExpr below — and everything
// else in this file exists to keep it the only one. It is phrased against a
// subject rather than against a "logged in?" flag on purpose: auth.From always
// yields an Identity, anonymous ones carrying an empty subject, and
// roadmap_members forbids an empty subject, so an anonymous caller matches no
// membership row without anything having to ask whether authentication is on.
// With auth off no private roadmap can be created either (see
// normalizeVisibility), so every roadmap is public and the predicate is
// trivially true — which is why an open deployment behaves exactly as it did
// before this file existed.
//
// Note the deliberate asymmetry with the trash: that one lives in the store,
// as two `deleted_at IS NULL` clauses in lockRoadmap and getRoadmapFull,
// because it needs no caller. Access does need one, and the store has callers
// that have no user at all — the trash sweeper, seeding, snapshot capture and
// pruning, and the internal getRoadmapFull behind export and duplicate. A store
// that consulted the request identity would 404 its own background jobs. So the
// check happens once in the server's route wrapper, against the roadmap id the
// request names, and the store only supplies the predicate.

// The SQL fragments below are all written over a `roadmaps` row with **the
// acting subject bound as $1**. Every query in this package that embeds one
// binds it there, so the fragments compose without each caller re-deriving the
// rule — the point being that these two expressions are the only statements of
// "may see" and "may change" anywhere.

// visibleExpr is the access rule. It deliberately says nothing about
// deleted_at: restoring and purging authorize a *trashed* roadmap, and the
// existing deleted_at clauses elsewhere keep doing their own, separate job.
const visibleExpr = `roadmaps.visibility = 'public' OR EXISTS (
	SELECT 1 FROM roadmap_members m WHERE m.roadmap_id = roadmaps.id AND m.subject = $1
)`

// ownerExpr is the ownership rule: whether $1 may change this roadmap's
// visibility. Separate from visibleExpr because ownership is recorded for
// public roadmaps too, where it grants nothing extra to *see*.
const ownerExpr = `EXISTS (
	SELECT 1 FROM roadmap_members m WHERE m.roadmap_id = roadmaps.id AND m.subject = $1 AND m.role = 'owner'
)`

// ownedExpr is ownerExpr as a selectable column, for the listings that report
// model.Roadmap.Owned.
const ownedExpr = ownerExpr + ` AS owned`

// normalizeVisibility validates a requested visibility and enforces the one
// rule that makes anonymous callers harmless: a private roadmap must have an
// owner, or nobody could ever reach it. An empty value defaults to public.
func normalizeVisibility(vis, owner string) (string, error) {
	switch vis {
	case "", model.VisibilityPublic:
		return model.VisibilityPublic, nil
	case model.VisibilityPrivate:
		if owner == "" {
			return "", invalidf("a private roadmap needs an owner; sign in to create one")
		}
		return model.VisibilityPrivate, nil
	default:
		return "", invalidf("invalid visibility %q", vis)
	}
}

// insertOwner records subject as roadmapID's owner. An empty subject (an
// anonymous creator) records nothing: the roadmap is then unowned, which is
// permanent — nobody can claim it later, so it stays public forever.
func insertOwner(ctx context.Context, tx pgx.Tx, roadmapID int64, subject string) error {
	if subject == "" {
		return nil
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO roadmap_members (roadmap_id, subject, role) VALUES ($1, $2, 'owner')`,
		roadmapID, subject)
	return err
}

// CanAccessRoadmap reports whether viewer may see and edit roadmapID. It is the
// single authorization query, called from the server's route wrapper for every
// request that names a roadmap. A roadmap that does not exist reports
// ErrNotFound, which the API renders identically to a denial — a caller must
// not be able to tell a private roadmap from a nonexistent one.
func (s *Store) CanAccessRoadmap(ctx context.Context, roadmapID int64, viewer string) error {
	var ok bool
	err := s.pool.QueryRow(ctx,
		`SELECT (`+visibleExpr+`) FROM roadmaps WHERE roadmaps.id = $2`, viewer, roadmapID).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}

// IsRoadmapOwner reports whether subject owns roadmapID, i.e. may change its
// visibility. Used to set model.Roadmap.Owned on the single-roadmap read; the
// listings derive the same flag in SQL via ownedExpr.
func (s *Store) IsRoadmapOwner(ctx context.Context, roadmapID int64, subject string) (bool, error) {
	if subject == "" {
		return false, nil
	}
	var owned bool
	err := s.pool.QueryRow(ctx,
		`SELECT (`+ownerExpr+`) FROM roadmaps WHERE roadmaps.id = $2`, subject, roadmapID).Scan(&owned)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // no such roadmap: nobody owns it
	}
	return owned, err
}

// SetRoadmapVisibility makes a roadmap private or public. Only its owner may do
// so, and that is the whole rule: a roadmap with no owner — anything created
// before visibility existed, or with auth off — can never change, because there
// is nobody who could. Trying reports ErrNotFound, like every other denial.
//
// One statement, whose WHERE clause is also its precondition, so it needs no
// lock: two concurrent attempts cannot both report success, and an UPDATE of
// the roadmaps row already serializes against the SELECT ... FOR UPDATE that
// every content mutation takes.
func (s *Store) SetRoadmapVisibility(ctx context.Context, roadmapID int64, vis, actor string) (model.Roadmap, error) {
	if vis != model.VisibilityPublic && vis != model.VisibilityPrivate {
		return model.Roadmap{}, invalidf("invalid visibility %q", vis)
	}
	if actor == "" {
		return model.Roadmap{}, ErrNotFound
	}
	rm, err := scanRoadmap(s.pool.QueryRow(ctx,
		`UPDATE roadmaps SET visibility = $3, updated_at = now()
		 WHERE roadmaps.id = $2 AND deleted_at IS NULL AND `+ownerExpr+`
		 RETURNING `+roadmapCols, actor, roadmapID, vis))
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Roadmap{}, ErrNotFound
	}
	if err != nil {
		return model.Roadmap{}, err
	}
	rm.Owned = true // only the owner reaches here
	return rm, nil
}
