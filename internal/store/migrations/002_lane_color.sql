ALTER TABLE lanes ADD COLUMN color TEXT NOT NULL DEFAULT 'blue';

-- Give existing lanes some variety, matching the auto-assignment on creation.
UPDATE lanes SET color = (ARRAY['blue','green','red','orange','purple'])[(position % 5) + 1];
