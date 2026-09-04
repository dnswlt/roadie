-- Milestones carry the same roadmap-local classification and attention marker
-- as items. Their planning risk joins tentative as a provider-owned signal on
-- integration mirrors; the stored false is replaced on resolved reads.
ALTER TABLE milestones ADD COLUMN labels  TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE milestones ADD COLUMN flagged BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE milestones ADD COLUMN at_risk BOOLEAN NOT NULL DEFAULT false;
