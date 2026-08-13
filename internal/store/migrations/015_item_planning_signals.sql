-- Two planning signals, booleans like the attention flag (010) and for the same
-- reason: the meaning belongs to the product, so there is nothing to configure.
--
--   tentative: the item's dates are an estimate, not a commitment.
--   at_risk:   the dates still stand, but something threatens them.
--
-- Not workflow status: no confidence percentages, no off-track/blocked/done.
ALTER TABLE items ADD COLUMN tentative BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN at_risk   BOOLEAN NOT NULL DEFAULT false;
