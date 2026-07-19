-- Optional priority for items: P1..P4 (1 = highest). NULL means the item
-- is unprioritized. Purely an item attribute; not tied to lane or rank.
ALTER TABLE items ADD COLUMN priority SMALLINT
    CHECK (priority IS NULL OR priority BETWEEN 1 AND 4);
