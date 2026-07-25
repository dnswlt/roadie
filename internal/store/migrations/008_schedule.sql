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
