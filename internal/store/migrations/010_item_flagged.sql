-- Items can be flagged: one product-defined "needs attention" marker.
--
-- Deliberately a column and not a reserved label. Labels are free-form user
-- text, so a magic "flagged" string would be a convention rather than an
-- invariant (nothing stops "Flagged"/"FLAG"/a user's own tag), it would leak
-- into the label editor as a deletable chip, and toggling it would mean
-- rewriting the whole label array -- which loses concurrent label edits under
-- the very burst usage the flag is for.
ALTER TABLE items ADD COLUMN flagged BOOLEAN NOT NULL DEFAULT false;
