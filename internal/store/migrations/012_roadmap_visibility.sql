-- Private vs. public roadmaps, and the membership list that makes a private
-- one reachable.
--
-- Visibility is an explicit column rather than something derived from "does
-- this roadmap have members?". Deriving it would fail *open*: any bug that
-- removed the last member row would silently publish a roadmap, and "make this
-- private" would stop being a single statement. A private roadmap with no
-- members is unreachable, which is the safe direction to fail.
--
-- The access rule is one predicate, and it is deliberately phrased so that it
-- needs no knowledge of whether the server runs with authentication on:
--
--     visible to subject S  <=>  visibility = 'public' OR S is a member
--
-- auth.From always yields an Identity, anonymous ones carrying an empty
-- subject, and the CHECK below makes an empty subject unstorable. So an
-- anonymous caller structurally matches no member row, and with auth off no
-- private roadmap can be created in the first place (the store rejects a
-- private roadmap with no owner) — which is why an open deployment behaves
-- exactly as it always has, with no mode check anywhere in the code.
--
-- The reverse transition is fail-closed on purpose: a deployment that ran with
-- OIDC, accumulated private roadmaps and then restarts with auth off hides them
-- from everyone. Making anonymous callers see everything instead would put an
-- "is auth on?" branch in the one place it must never be.
ALTER TABLE roadmaps ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('private', 'public'));

-- One row per person who can reach a private roadmap. Keyed by the OIDC
-- subject, like roadmap_contributors — there is no user table to reference.
--
-- Today only the creator is ever inserted, so a single owner_subject column on
-- roadmaps would carry the same data. The table is worth having anyway: the
-- access predicate written against it (EXISTS ... roadmap_members) is the same
-- predicate after sharing lands, whereas owner_subject = $1 would have to be
-- rewritten in the list query, the route wrapper and every test. The schema is
-- the cheap part to migrate; the predicate is not.
--
-- role is only ever written as 'owner' for now. 'editor' is already allowed so
-- that sharing widens a CHECK instead of adding a column. Note that ownership
-- is recorded for *public* roadmaps too: access does not consult it there, but
-- it is what answers "who may change this roadmap's visibility". Roadmaps that
-- predate this migration, and any created while running with auth off, have no
-- owner at all and are therefore permanently public — nobody can claim them.
CREATE TABLE roadmap_members (
    roadmap_id BIGINT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    subject    TEXT   NOT NULL CHECK (subject <> ''),
    role       TEXT   NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'editor')),
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (roadmap_id, subject)
);

-- At most one owner per roadmap, enforced rather than assumed: "who may change
-- visibility" has to have a single answer.
CREATE UNIQUE INDEX roadmap_members_owner_idx ON roadmap_members (roadmap_id) WHERE role = 'owner';

-- Serves the listing predicate, which looks up a subject's roadmaps.
CREATE INDEX roadmap_members_subject_idx ON roadmap_members (subject);
