-- Consolidated current database schema for Roadie.
--
-- This is the single, readable source of truth for the current schema. A FRESH
-- database is built from this file in one step (see store.Migrate), which then
-- records every existing migration as already applied. Existing databases are
-- upgraded incrementally by the numbered files in migrations/ instead.
--
-- Keep this in sync with migrations/: whenever you add a NNN_*.sql migration,
-- fold the same change into this file. TestSchemaMatchesMigrations guards that
-- the two agree. (The schema_migrations bookkeeping table is created by
-- store.Migrate itself, so it is intentionally not defined here.)

-- deleted_at is the trash can: a deleted roadmap is marked, not removed, so it
-- can be restored with everything under it (nothing cascades on a mark). NULL
-- means live. See migrations/011_roadmap_deleted.sql.
--
-- visibility is 'public' (everyone, including anonymous callers) or 'private'
-- (only the subjects in roadmap_members). See migrations/012_roadmap_visibility.sql.
CREATE TABLE roadmaps (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    visibility TEXT NOT NULL DEFAULT 'public'
        CHECK (visibility IN ('private', 'public'))
);

CREATE TABLE lanes (
    id         BIGSERIAL PRIMARY KEY,
    roadmap_id BIGINT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   INT NOT NULL,
    color      TEXT NOT NULL DEFAULT 'blue',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX lanes_roadmap_idx ON lanes (roadmap_id, position);

CREATE TABLE items (
    id          BIGSERIAL PRIMARY KEY,
    lane_id     BIGINT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
    parent_id   BIGINT REFERENCES items(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    rank        INT NOT NULL DEFAULT 0,
    priority    SMALLINT CHECK (priority IS NULL OR priority BETWEEN 1 AND 4),
    labels      TEXT[] NOT NULL DEFAULT '{}',
    -- One product-defined "needs attention" marker, not a user-named tag: the
    -- meaning belongs to the app, so it can be a glyph with nothing to look up.
    flagged     BOOLEAN NOT NULL DEFAULT false,
    -- Planning signals, product-defined booleans like the flag: dates are an
    -- estimate (tentative) and dates are threatened (at_risk). Independent of
    -- each other and of the flag; deliberately not workflow status.
    tentative   BOOLEAN NOT NULL DEFAULT false,
    at_risk     BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (start_date <= end_date)
);

CREATE INDEX items_lane_idx ON items (lane_id);
CREATE INDEX items_parent_idx ON items (parent_id);

CREATE TABLE milestones (
    id          BIGSERIAL PRIMARY KEY,
    lane_id     BIGINT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    date        DATE NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX milestones_lane_idx ON milestones (lane_id);

-- Dependencies: directed edges between items and milestones of one roadmap.
--
-- An edge points FROM the prerequisite TO the dependent: "to needs from".
-- Exactly one column of each from_/to_ pair is set, selecting the endpoint's
-- kind; the FK cascades make deletion correct by construction (removing an
-- item, a milestone, a lane, or a whole roadmap takes its edges along).
--
-- There is deliberately nothing else on an edge — no type, no lag, no label:
-- one edge kind whose meaning the product owns. The remaining invariants
-- (both endpoints in the same roadmap, no self-edges, the graph is acyclic)
-- are enforced in internal/store, per the house rule.
CREATE TABLE dependencies (
    id                BIGSERIAL PRIMARY KEY,
    roadmap_id        BIGINT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    from_item_id      BIGINT REFERENCES items(id)      ON DELETE CASCADE,
    from_milestone_id BIGINT REFERENCES milestones(id) ON DELETE CASCADE,
    to_item_id        BIGINT REFERENCES items(id)      ON DELETE CASCADE,
    to_milestone_id   BIGINT REFERENCES milestones(id) ON DELETE CASCADE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(from_item_id, from_milestone_id) = 1),
    CHECK (num_nonnulls(to_item_id, to_milestone_id) = 1)
);

-- One edge per ordered endpoint pair. NULLS NOT DISTINCT so the unset half of
-- each pair doesn't make every row unique (PG15+).
CREATE UNIQUE INDEX dependencies_edge_idx ON dependencies
    (from_item_id, from_milestone_id, to_item_id, to_milestone_id) NULLS NOT DISTINCT;

CREATE INDEX dependencies_roadmap_idx ON dependencies (roadmap_id, id);

-- One index per endpoint column: the FK cascades delete by each of these, and
-- endpoint deletion looks up edges through each side.
CREATE INDEX dependencies_from_item_idx ON dependencies (from_item_id);
CREATE INDEX dependencies_from_milestone_idx ON dependencies (from_milestone_id);
CREATE INDEX dependencies_to_item_idx ON dependencies (to_item_id);
CREATE INDEX dependencies_to_milestone_idx ON dependencies (to_milestone_id);

-- Snapshots: point-in-time copies of a roadmap's full contents, for version
-- history ("go back", not undo). Each row stores the same self-describing
-- payload the export/import feature uses (a model.RoadmapExport envelope),
-- serialized as JSON in a BYTEA column -- deliberately not JSONB, since we
-- never query into it from SQL, only read the whole blob back. Auto snapshots
-- (kind = 'auto') are pruned; named ones (kind = 'manual') are kept.
CREATE TABLE snapshots (
    id             BIGSERIAL PRIMARY KEY,
    roadmap_id     BIGINT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    name           TEXT,
    kind           TEXT NOT NULL DEFAULT 'auto',
    format_version INT  NOT NULL,
    data           BYTEA NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX snapshots_roadmap_idx ON snapshots (roadmap_id, created_at DESC);

-- Schedule: a roadmap-level sequence of named time periods (sprints, PIs, ...),
-- the planning rhythm the timeline can snap to and display above the calendar.
-- Unlike lanes/items this is a flat, roadmap-scoped list with no rank: periods
-- are positioned purely by their dates (read back ordered by start_date). There
-- is a single schedule per roadmap; replacing it is a full-set swap.
CREATE TABLE schedule_periods (
    id         BIGSERIAL PRIMARY KEY,
    roadmap_id BIGINT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    label      TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date   DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (start_date <= end_date)
);

CREATE INDEX schedule_periods_roadmap_idx ON schedule_periods (roadmap_id, start_date);

-- Contributors: who has edited a roadmap, and the window over which they did.
-- Unlike every other roadmap-scoped table here this is editing metadata rather
-- than roadmap content, so it stays out of the RoadmapExport envelope and
-- survives a snapshot restore untouched (see migrations/009_contributors.sql).
-- Keyed by OIDC subject; the display name is denormalized because there is no
-- user table to join against.
CREATE TABLE roadmap_contributors (
    roadmap_id BIGINT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    subject    TEXT   NOT NULL,
    name       TEXT   NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (roadmap_id, subject)
);

-- Who can reach a private roadmap, keyed by OIDC subject. The empty subject an
-- anonymous identity carries is unstorable (CHECK below), which is what lets
-- one access predicate serve both auth modes. Ownership is recorded for public
-- roadmaps too — access ignores it there, but it answers who may change the
-- visibility. See migrations/012_roadmap_visibility.sql.
CREATE TABLE roadmap_members (
    roadmap_id BIGINT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    subject    TEXT   NOT NULL CHECK (subject <> ''),
    role       TEXT   NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'editor')),
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (roadmap_id, subject)
);

CREATE UNIQUE INDEX roadmap_members_owner_idx ON roadmap_members (roadmap_id) WHERE role = 'owner';

CREATE INDEX roadmap_members_subject_idx ON roadmap_members (subject);
