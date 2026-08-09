-- Dependencies are roadmap-level content. Store their aggregate ownership
-- explicitly so roadmap reads, authorization and locking do not have to infer
-- it by joining through one endpoint and its lane.
ALTER TABLE dependencies ADD COLUMN roadmap_id BIGINT REFERENCES roadmaps(id) ON DELETE CASCADE;

UPDATE dependencies d
SET roadmap_id = COALESCE(
    (SELECT l.roadmap_id FROM items i JOIN lanes l ON l.id = i.lane_id
     WHERE i.id = d.from_item_id),
    (SELECT l.roadmap_id FROM milestones m JOIN lanes l ON l.id = m.lane_id
     WHERE m.id = d.from_milestone_id)
);

ALTER TABLE dependencies ALTER COLUMN roadmap_id SET NOT NULL;

CREATE INDEX dependencies_roadmap_idx ON dependencies (roadmap_id, id);
