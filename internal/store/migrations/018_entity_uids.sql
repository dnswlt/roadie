-- Portable identity for the two entities that can be named from outside their
-- own roadmap: the roadmap itself and its milestones (notes/stable_uids.md).
--
-- A database ID names a logical entity in this database and stays the
-- identifier for foreign keys, mutations, diffs and every client reference. A
-- UID names an entity that may be referred to from outside its roadmap, or from
-- a payload that outlives the rows it came from, and is immutable from creation
-- — which is why every milestone gets one, not only the ones ever published.
--
-- Lanes and items deliberately get none. Cross-roadmap dependencies locate
-- their source by milestone UID and keep their own endpoint as a plain foreign
-- key, so nothing outside a roadmap ever names a lane or an item; giving them
-- UIDs would build the addressing layer for a global graph that Roadie refuses
-- (notes/external_milestones.md). Dependencies and schedule periods get none
-- either: an edge is identified by its endpoint pair, and periods are replaced
-- as a set and compared by value.
--
-- Existing rows are filled by the default, so every roadmap and milestone that
-- predates this migration acquires a UID here rather than lazily later.
ALTER TABLE roadmaps ADD COLUMN uid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE roadmaps ADD CONSTRAINT roadmaps_uid_key UNIQUE (uid);

ALTER TABLE milestones ADD COLUMN uid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE milestones ADD CONSTRAINT milestones_uid_key UNIQUE (uid);
