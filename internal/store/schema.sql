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

CREATE TABLE roadmaps (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
