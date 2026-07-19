-- Milestones: a fixed date within a swimlane (context) at which something
-- happens or must happen. Unlike items they have no duration and no ranking;
-- they are positioned purely by their date.
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
