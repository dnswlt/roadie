-- Snapshots: point-in-time copies of a roadmap's full contents, for version
-- history ("go back", not undo). Each row stores the same self-describing
-- payload the export/import feature uses (a model.RoadmapExport envelope),
-- serialized as JSON in a BYTEA column -- deliberately not JSONB, since we
-- never query into it from SQL, only read the whole blob back.
--
-- Most snapshots are captured automatically (kind = 'auto'); those are subject
-- to retention/pruning. Named snapshots (kind = 'manual', a non-null name) are
-- kept indefinitely. The name column is present now so the schema is ready for
-- the naming feature even before it is wired up.
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
