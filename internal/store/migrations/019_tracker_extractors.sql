-- The schedule-check extractor script (notes/schedule_check.md): the Starlark
-- saying which tracker fields carry an issue's schedule. Like saved queries it
-- is operational recon config, not roadmap content — outside RoadmapFull,
-- snapshots, exports and duplication — and it cascades on roadmap delete.
--
-- roadmap_id is the primary key: at most one script per roadmap, which is what
-- makes the routes roadmap-scoped and needs no id of its own.
CREATE TABLE tracker_extractors (
    roadmap_id BIGINT PRIMARY KEY REFERENCES roadmaps(id) ON DELETE CASCADE,
    source     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
