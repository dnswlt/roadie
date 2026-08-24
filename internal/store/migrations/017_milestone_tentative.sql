-- Milestones can carry the same timing commitment signal as items. It is
-- roadmap content, so the field also rides in exports and snapshots.
ALTER TABLE milestones ADD COLUMN tentative BOOLEAN NOT NULL DEFAULT false;
