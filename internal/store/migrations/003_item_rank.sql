-- Explicit vertical order of items within their container (lane for
-- top-level items, parent for children). Dense 0..n-1 per container.
ALTER TABLE items ADD COLUMN rank INT NOT NULL DEFAULT 0;

UPDATE items SET rank = t.rn - 1
FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY lane_id, parent_id ORDER BY start_date, id) AS rn
    FROM items
) t
WHERE items.id = t.id;
