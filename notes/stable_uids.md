# Stable Identity, Restore, and Imports

## Goals

* Make version diffs describe content changes across a restore instead of
  reporting every restored entity as removed and added.
* Keep durable references — shareable links, view preferences — pointing at
  their entities across a restore.
* Give the entities a roadmap publishes to other roadmaps a portable identity
  that survives restore, duplication, and transfer between installations.
* Make file import semantics explicit and deterministic: importing a copy and
  transferring the same roadmap are different operations selected by the user,
  never inferred from UID collisions.
* Add no more identity than those require.

## Two Identities

A **database ID** names a logical entity within one installation. It stays the
identifier for foreign keys, mutations, locking, DOM interaction, version
diffs, and every client reference.

A **UID** names an entity that can be referred to from outside its roadmap or
outside its installation. Only roadmaps and milestones have one.

The settled rule this commits to:

> A database ID names a logical entity, not a physical row.

A restored item is the item that came back, not a new one wearing its number.
Any later feature that stores a reference outside the cascade — an audit log,
comments, an external link — must accept that a restore re-binds it rather than
leaving it dangling.

Lanes and items get no UID. Cross-roadmap dependencies locate their source by
milestone UID and keep consumer-owned endpoints as hard foreign keys by
database ID, so nothing outside a roadmap ever names a lane or an item.
Giving them UIDs would build the addressing layer for the global graph
[integration milestones](external_milestones.md) deliberately refuses:
milestones export, items import, and the UID is the mark of that.

## Restore Preserves Database IDs

Restore inserts the snapshot's own lane, item, and milestone IDs instead of
fresh ones; the local remapping in `insertRoadmapContents` becomes the identity
function for that policy. Every other operation keeps assigning fresh IDs and
remapping as it does today.

This is safe because sequences never rewind: an ID once issued is permanently
retired and can never collide with a future auto-assigned one. Restore deletes
the roadmap's lanes first, in the same transaction and under the roadmap lock,
so nothing inside the roadmap collides either. A collision that somehow existed
is rejected by the primary key and rolls the transaction back.

Ordering is unaffected. Database IDs are only tiebreakers after `position`,
`rank`, `date`, and `name`, so restored IDs restore the original tiebreak.

Besides the diff, this keeps three things working that renumbering breaks
today: the shareable link's `?item=` / `?milestone=` target, the per-roadmap
view preferences that prune against current IDs (hidden lanes, collapsed
parents, WBS milestone groups), and a consumer's external dependencies, whose
`dependent_item_id` still points at its item.

Restore writes each entity's `updated_at` from the snapshot, so a restored
roadmap does not claim every entity was edited at the restore moment. The
roadmap row's own `updated_at` moves to now, because the roadmap did change.

## Entity UIDs

```sql
roadmaps.uid   UUID NOT NULL UNIQUE DEFAULT gen_random_uuid()
milestones.uid UUID NOT NULL UNIQUE DEFAULT gen_random_uuid()
```

Every milestone gets a UID at insert, not only integration milestones: a
milestone may be published later, and a UID must be immutable from creation.

The roadmap UID is not needed to resolve a cross-roadmap reference — a
milestone UID is globally unique on its own. It exists for transfer import,
which needs a stable answer to "is this same roadmap already here" that also
holds for a roadmap with no milestones. Drop it if transfer is dropped.

Carry `uid` through the Go and TypeScript models, roadmap reads, snapshots, and
exports. It is returned by APIs but never accepted in a patch: a UID cannot
change during an entity's lifetime.

Dependencies and schedule periods get no UID. A dependency is identified by its
endpoint pair; schedule periods are replaced as a set and diff by value.

## Content Insertion Policies

The operation selects the policy before insertion; database contents never
select it implicitly.

| Operation | Database IDs | Roadmap UID | Milestone UIDs |
| --- | --- | --- | --- |
| Create | Fresh | Generate | Generate |
| Snapshot restore | **Preserve from snapshot** | Keep current | Preserve from snapshot |
| Duplicate | Fresh | Generate | Generate |
| Import as copy | Fresh | Generate | Generate |
| Transfer identity | Fresh | Preserve from file | Preserve from file |

Restore preserves the UID of every milestone present in the checkpoint. A
milestone absent from it disappears; restoring another checkpoint that contains
it makes the same logical identity current again.

Duplicate always creates independent identities. It must not call an import
path whose identity behavior depends on what already exists.

### Snapshots Predating UIDs

No alias table. Inside the restore transaction, before deleting, read
`(id → uid)` for the roadmap's current milestones. For each milestone in the
blob: use its UID when it has one, otherwise inherit the UID of the row that
held that database ID, otherwise generate one. The database ID is the alias
key, and the row is right there in the same transaction.

The case a persistent alias table would additionally cover — a milestone
published, consumed, deleted, then restored from a pre-UID snapshot — cannot
occur: external dependencies ship after UIDs, so any snapshot holding a
consumed milestone already carries one.

## Import Modes

The import API and dialog expose two modes:

* **Import as copy** creates an independent roadmap. It always generates a new
  roadmap UID and new UIDs for every owned milestone. It never inspects UID
  collisions to choose its behavior, so repeated copy imports predictably
  create repeated independent roadmaps.
* **Transfer identity** moves the same logical roadmap to another installation,
  preserving the roadmap and milestone UIDs from the file. It performs an
  atomic preflight: if the roadmap UID or any owned milestone UID already
  exists, it writes nothing and reports the conflicting roadmap. It never falls
  back to copy semantics.

There is no import-over-existing or inferred replace mode. Version history is
the mechanism for restoring an existing roadmap. A replace mode, if ever
needed, must be a separately named operation.

Exports predating UIDs cannot be imported at all — a hard breaking change,
taken so that no third set of identity rules exists for files that carry none.
The export format version advances, and the importer refuses anything older
rather than guessing from partially populated payloads. Every import, copy
included, requires a UID for the roadmap and for every milestone.

Visibility and ownership keep their current rules. Transfer preserves content
identity, not access: the caller still chooses the new roadmap's visibility and
becomes its owner exactly as for an ordinary import.

## Version Diff

Unchanged. It keeps matching lanes, items, and milestones by database ID, which
is now stable across a restore, and keeps comparing placement by `laneId` and
`parentId`, order by ID, and dependencies by numeric endpoint pair.

The defining regression test restores a snapshot and diffs the result against
that snapshot: same content, same IDs, empty diff. A test that merely swapped
database IDs while holding UIDs equal would pin an identity function rather
than the behavior users see.

## Durable Client References

Unchanged. Item and milestone selections in the address bar, collapsed item
state, hidden lane state, and WBS milestone-group state all keep using database
IDs. There is nothing to migrate and no compatibility period.

## Verification

Store and server tests cover ID-preserving restore (round trip; an entity
absent from the checkpoint stays gone; restoring a restore), that inserts after
a restore still receive fresh IDs, milestone and roadmap UID generation and
immutability, snapshot round trips, restore preservation, the pre-UID snapshot
fallback, duplicate regeneration, both import modes, transfer conflict
atomicity, and old export handling.

Frontend tests keep the existing diff coverage and add the restore round trip
above. Selection and view state are checked across a restore.

Complete this feature before adding cross-roadmap dependencies.
