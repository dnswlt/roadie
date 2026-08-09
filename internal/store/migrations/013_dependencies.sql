-- Dependencies: directed edges between items and milestones of one roadmap.
--
-- An edge points FROM the prerequisite TO the dependent: "to needs from".
-- Exactly one column of each from_/to_ pair is set, selecting the endpoint's
-- kind; the FK cascades make deletion correct by construction (removing an
-- item, a milestone, a lane, or a whole roadmap takes its edges along).
--
-- There is deliberately nothing else on an edge — no type, no lag, no label:
-- one edge kind whose meaning the product owns. The remaining invariants
-- (both endpoints in the same roadmap, no self-edges, the graph is acyclic)
-- are enforced in internal/store, per the house rule.
CREATE TABLE dependencies (
    id                BIGSERIAL PRIMARY KEY,
    from_item_id      BIGINT REFERENCES items(id)      ON DELETE CASCADE,
    from_milestone_id BIGINT REFERENCES milestones(id) ON DELETE CASCADE,
    to_item_id        BIGINT REFERENCES items(id)      ON DELETE CASCADE,
    to_milestone_id   BIGINT REFERENCES milestones(id) ON DELETE CASCADE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(from_item_id, from_milestone_id) = 1),
    CHECK (num_nonnulls(to_item_id, to_milestone_id) = 1)
);

-- One edge per ordered endpoint pair. NULLS NOT DISTINCT so the unset half of
-- each pair doesn't make every row unique (PG15+).
CREATE UNIQUE INDEX dependencies_edge_idx ON dependencies
    (from_item_id, from_milestone_id, to_item_id, to_milestone_id) NULLS NOT DISTINCT;

-- One index per endpoint column: the FK cascades delete by each of these, and
-- the per-roadmap load joins through the from_ side.
CREATE INDEX dependencies_from_item_idx ON dependencies (from_item_id);
CREATE INDEX dependencies_from_milestone_idx ON dependencies (from_milestone_id);
CREATE INDEX dependencies_to_item_idx ON dependencies (to_item_id);
CREATE INDEX dependencies_to_milestone_idx ON dependencies (to_milestone_id);
