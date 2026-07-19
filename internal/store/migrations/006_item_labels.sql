-- Free-form labels (tags) on items: many per item, shared across the roadmap.
-- The known-label set is derived from what's in use (no separate labels table),
-- keeping with the "radically simple data model" principle. Used both to
-- categorize items and to "focus" the view on one label (graying out the rest).
ALTER TABLE items ADD COLUMN labels TEXT[] NOT NULL DEFAULT '{}';
