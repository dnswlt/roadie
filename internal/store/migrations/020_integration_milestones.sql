-- Whether other roadmaps may mirror this milestone.
ALTER TABLE milestones ADD COLUMN integration_milestone BOOLEAN NOT NULL DEFAULT false;

-- Non-NULL on a mirror, naming the milestone it mirrors. Deliberately not a
-- foreign key: the source may be removed and the mirror outlives it.
-- Cross-roadmap rules are in internal/store/mirrors.go.
ALTER TABLE milestones ADD COLUMN source_milestone_uid UUID;

-- A mirror is never itself an integration milestone.
ALTER TABLE milestones ADD CONSTRAINT milestones_mirror_not_integration
    CHECK (NOT (integration_milestone AND source_milestone_uid IS NOT NULL));

-- Mirror lookup by source.
CREATE INDEX milestones_source_uid_idx ON milestones (source_milestone_uid)
    WHERE source_milestone_uid IS NOT NULL;
