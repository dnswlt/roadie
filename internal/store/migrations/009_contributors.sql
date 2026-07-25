-- Contributors: who has edited a roadmap, and the window over which they did.
--
-- This records the *editing history* of a roadmap, not its content. That is why
-- it deliberately does not ride in the RoadmapExport envelope the way lanes,
-- items, milestones and schedule_periods do: restoring a January snapshot must
-- not un-person everyone who edited in June. The test that settles it for any
-- future field is "if I restore this snapshot, should this data revert too?" —
-- yes for the schedule (you want the old sprints back), no for this. So
-- RestoreSnapshot leaves this table alone, while clearing schedule_periods
-- explicitly a few lines away.
--
-- One row per person per roadmap, keyed by the OIDC subject. There is no user
-- table to join against (see internal/auth), so the display name is
-- denormalized here and refreshed on every edit. Deliberately no edit counter:
-- the set of people is the feature, and a count of PATCH requests would measure
-- who drags big parents around, not who did the work.
CREATE TABLE roadmap_contributors (
    roadmap_id BIGINT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
    subject    TEXT   NOT NULL,
    name       TEXT   NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (roadmap_id, subject)
);
