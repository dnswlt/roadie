-- Saved tracker queries ("favourites", notes/JIRA.md) for the reconciliation
-- view. Roadmap-scoped and deleted with the roadmap, but operational recon
-- data rather than roadmap content: outside RoadmapFull, snapshots, exports
-- and duplication, so restoring a plan never resurrects an old favourite.
CREATE TABLE tracker_queries (
    id         BIGSERIAL PRIMARY KEY,
    roadmap_id BIGINT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    query      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The picker offers names alone, so one name names one query per roadmap.
-- The store pre-checks under the roadmap lock; this index is the backstop.
CREATE UNIQUE INDEX tracker_queries_name_idx ON tracker_queries (roadmap_id, name);
