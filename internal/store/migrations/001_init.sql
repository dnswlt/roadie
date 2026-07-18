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
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (start_date <= end_date)
);

CREATE INDEX items_lane_idx ON items (lane_id);
CREATE INDEX items_parent_idx ON items (parent_id);
