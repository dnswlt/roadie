# Integration Milestones as Cross-Roadmap Sync Points

## Goal

Allow roadmaps to express dependencies on work planned in other roadmaps without turning Roadie into a global dependency graph.

Cross-roadmap dependencies represent **integration or synchronization points**:

> Work in roadmap A cannot complete before a defined milestone in roadmap B has been reached.

The model should deliberately constrain which entities may participate in cross-roadmap dependencies so that dependencies remain understandable and locally meaningful.

## Core Concept

A roadmap may explicitly expose selected milestones for use by other roadmaps. These are called **integration milestones**.

> **Integration milestone**: a milestone explicitly exposed by its owning roadmap so that items in other roadmaps may depend on it.

An integration milestone is still fully **owned and planned by its original roadmap**, but other roadmaps may rely on it.

Examples:

* API available
* Infrastructure ready
* Interface frozen
* Migration completed
* Regulatory approval received
* Integration environment ready

Most milestones remain internal planning details of their roadmap. Integration milestones form the intentionally small external interface of a roadmap.

## Integration Milestones

A milestone gains an explicit property indicating that other roadmaps may depend on it, for example:

```yaml
integrationMilestone: true
```

The exact data-model field name may differ, but **integration milestone** is the canonical user-facing term.

The important semantic distinction is:

> An integration milestone is a promise made by its owning roadmap that other roadmaps are allowed to rely on.

The milestone is effectively **published** for external dependency use, but “published milestone” is not a separate concept or canonical term.

## Ownership

There is always exactly **one milestone entity**, owned by its roadmap.

When another roadmap depends on it, Roadie may visually project or "mirror" that milestone into the consuming roadmap, but this is not a copy of the milestone.

The consuming roadmap therefore cannot:

* edit the milestone,
* move its date,
* rename it,
* change its state.

Changes made by the owning roadmap are directly reflected wherever the milestone is referenced.

The consuming roadmap owns only its dependency on that milestone.

## Dependency Direction

Dependencies are declared using `dependsOn`.

There is no independently maintained `neededBy` relationship. `neededBy` is derived from reverse lookup of `dependsOn`.

For example:

```text
Roadmap B                         Roadmap A

[API available]  ──────────────▶  Integrate API
                                  dependsOn B/API available
```

Roadmap A declares the dependency. Roadmap B does not declare that A needs it.

## Cross-Roadmap Dependency Rule

Cross-roadmap dependencies are deliberately asymmetric.

### Export

Only an **integration milestone** may be the prerequisite of a cross-roadmap dependency.

In other words:

> **Milestones export.**

Ordinary items cannot become arbitrary dependency targets for other roadmaps.

### Import

External dependencies are consumed by ordinary items in the dependent roadmap.

In other words:

> **Items import.**

Example:

```text
Roadmap C                     Roadmap B

[API available] ───────────▶ Integrate C API
                                  │
                                  ▼
                         [Integration ready]
```

`API available` is an integration milestone in roadmap C.

`Integrate C API` belongs to roadmap B and declares `dependsOn` the milestone in C.

## No Direct Cross-Roadmap Milestone Dependencies

A milestone must not directly depend on a milestone from another roadmap.

Although a chain such as

```text
C/API available
    ↓
B/Integration ready
    ↓
A/Deployment ready
```

looks convenient, it hides what actually happens in each consuming roadmap.

Usually some local work occurs after an external integration milestone is reached:

* integrate,
* validate,
* approve,
* deploy,
* accept,
* switch over,
* test.

That local work should be represented explicitly.

Therefore this should instead be modeled as:

```text
C: [API available]
        │
        ▼
B: Integrate API
        │
        ▼
B: [Integration ready]
        │
        ▼
A: Perform deployment integration
        │
        ▼
A: [Deployment ready]
```

If there really is almost no local work, a very small connecting item is acceptable.

This slight modeling friction is intentional: it keeps cross-roadmap dependencies grounded in the consuming roadmap's work, rather than encouraging chains of milestones that effectively form a separate program-level plan.

## Resulting Invariants

The feature should enforce the following rules:

1. Every milestone belongs to exactly one roadmap.

2. A milestone must explicitly be declared an **integration milestone** before entities in other roadmaps may depend on it.

3. Cross-roadmap dependencies are always declared by the consuming roadmap using `dependsOn`.

4. `neededBy` is derived and never independently maintained.

5. For a dependency crossing roadmap boundaries, the prerequisite must be an integration milestone.

6. The dependent entity of a cross-roadmap dependency must be an item, not a milestone.

7. An integration milestone's own prerequisites belong to its owning roadmap.

8. Referencing a foreign integration milestone does not create a copied milestone. Any apparent "mirror" is a UI projection of the original entity.

These rules can be summarized as:

> **Milestones export; items import.**

## Lifecycle

Once another roadmap depends on an integration milestone, the owning roadmap must not silently invalidate that contract.

At minimum, Roadie should prevent or explicitly handle:

* deleting the milestone,
* removing its integration-milestone status.

Renaming, rescheduling, or otherwise updating the milestone remains the responsibility of the owning roadmap and should automatically propagate to consumers.

An integration milestone should be able to expose its consumers through a derived view such as:

```text
Used by 4 roadmaps
```

This information is useful for understanding impact without introducing a global dependency visualization.

## Design Intent

This feature is explicitly **not** intended to make all Roadie entities globally linkable.

The purpose is to provide a small, controlled interface between otherwise independent plans.

Roadmaps expose a handful of meaningful **integration milestones**. Other roadmaps can consume those milestones where their own work genuinely depends on them.

This preserves local roadmap ownership while allowing program-level coordination without dependency spaghetti.

## Backend Implementation Plan

This implementation assumes [stable identity and explicit import
semantics](stable_uids.md) are complete. Restore preserves database IDs;
roadmaps and milestones have immutable UIDs, which restore preserves too;
duplicate and copy import generate new owned UIDs; transfer import preserves
owned UIDs without collision fallbacks. Lanes and items have no UID — a
consumer names its own item by database ID.

### Representation

Keep local dependencies in `dependencies`, with their existing hard foreign
keys and roadmap-local DAG guarantees. Store cross-roadmap dependencies
separately because their lifecycle is deliberately weaker:

```text
foreign integration milestone → local item
```

An `external_dependencies` row contains:

* `consumer_roadmap_id`, a foreign key with `ON DELETE CASCADE`,
* `dependent_item_id`, a foreign key with `ON DELETE CASCADE`,
* `source_roadmap_uid`, the portable source-roadmap identity,
* `source_milestone_uid`, the portable integration-milestone identity.

The source locators are intentionally soft references, not foreign keys. A
source roadmap or milestone may disappear without deleting the consumer's
reference or preventing either roadmap from functioning. The dependent item
remains a hard reference because it is content owned by the consumer.

A unique index on `(dependent_item_id, source_milestone_uid)`: one dependency
per pair, as `dependencies_edge_idx` does for local edges.

This is still one user-facing dependency concept. The separate persistence
models the failure boundary; it does not introduce another edge kind, type,
lag, or label. No milestone copy or stored `neededBy` relationship is needed.

### Integration Milestone State

Add an `integration_milestone BOOLEAN NOT NULL DEFAULT false` column to
`milestones` in a new migration and in `schema.sql`. Carry the field through
`model.Milestone`, milestone creation and patch types, store reads and writes,
imports, snapshots, and the API as `integrationMilestone`.

### Dependency Invariants

Preserve the existing `dependencies` table and all same-roadmap dependency
combinations unchanged. When creating an external dependency, enforce the
following in the store:

1. The prerequisite is a milestone in another roadmap.
2. The prerequisite is marked as an integration milestone.
3. The dependent is an item in `consumer_roadmap_id`.
4. Foreign items, foreign dependents, and cross-roadmap milestone dependents
   are rejected.

Creation validates the source at that moment. After creation, resolving the
source is never an invariant of the consumer row: the milestone may later be
unpublished, deleted, hidden by access rules, or replaced by a source-roadmap
restore that does not contain the milestone UID.

The existing DAG check remains roadmap-local. An external milestone is a root
in the consuming graph, so it cannot create a local cycle. The backend should
not traverse all roadmaps to construct a second, global dependency graph.

### Failure Isolation

External dependencies must be a failure-containment boundary:

> A missing, stale, unpublished, or inaccessible external milestone must never
> make a consumer roadmap fail to load, preview, compare, duplicate, export,
> import, or restore.

Resolve source locators with left joins and return an explicit state such as
`available`, `unpublished`, `missing`, or `inaccessible`. Failed resolution is
data for a warning or indicator, not a store error.

Local writes continue to enforce local structure. External resolution must not
participate in transactions that replace local roadmap content, and an outage
or inconsistency in a source roadmap must not roll such a transaction back.

### Contract Lifecycle

Derive consumers by querying `external_dependencies` for the source roadmap and
milestone locators. This supports warnings such as `Used by 4 roadmaps` before
an owner changes or removes an integration milestone, but does not give the
consumer veto power over the source roadmap.

Clearing the integration property, deleting the milestone or lane, trashing or
purging its roadmap, and restoring its roadmap remain valid source-roadmap
operations. They leave consumer references unresolved.
Only the consuming roadmap may remove the dependency itself;
deleting its dependent item or roadmap removes the row by cascade.

### API Projections

A consuming roadmap needs the current source milestone data when it is
available, but must not own a copy of it. Add an `externalDependencies`
collection to its API representation, with the owned reference flat and the
resolved source nested under it:

* owned, and stored: the dependency ID, the dependent item ID, and the source
  roadmap and milestone UIDs,
* resolved per request and never stored: a nested `source`, carrying the
  resolution state and, when available, the milestone title, description, date
  and tentative state, plus its source roadmap and lane names.

`RoadmapFull` is not only the client payload: snapshot capture, export and
duplicate serialize the same struct. So resolution happens in the single-roadmap
read handler and in the snapshot preview handler, never in the store. The store
leaves `source` unset, so a payload built for a snapshot or an export never
contains a projection in the first place. Put the resolved fields alongside the
owned ones instead, and every writer has to remember to blank them.

The client reads a roadmap in one request, so the resolved state arrives with
it and the consumer side needs no second endpoint. `model.Roadmap.Owned` is
derived per request and kept out of stored payloads the same way.

Snapshot previews resolve their historical references against the current source
and show unavailable references rather than failing.

Add read-only APIs for discovering available integration milestones and for
reading a milestone's derived consumer count. `neededBy` remains a reverse
lookup, never independently stored.

Discovery and dependency creation apply the source roadmap's visibility rules.
Resolution after creation must degrade to an availability state rather than
failing the roadmap read. Inaccessible milestones should be treated the same
as non-existent ones.

### History, Duplication, and Import

An integration milestone's property belongs to its owning roadmap. An external
dependency belongs to its consuming roadmap. Apply the restore test and the
stable-identity insertion policies accordingly:

* A consumer snapshot stores the dependent item ID and both source UIDs.
  Restore re-inserts the row against the item's preserved database ID and
  retains the soft source identities without resolving them transactionally.
* A provider restore preserves the UID of a milestone present in the
  checkpoint, so consumers continue to resolve it. If the checkpoint omits it,
  consumers become `missing`; if it restores the milestone without the
  integration property, they become `unpublished`.
* Duplicating a consumer preserves foreign source UIDs. Duplicating a provider
  generates new milestone UIDs, so the duplicate makes independent promises
  and inherits no consumers.
* Copy import preserves foreign source UIDs but generates new UIDs for
  milestones owned by the imported roadmap. On the same installation its
  external references may resolve immediately; elsewhere they remain warnings
  until their providers arrive.
* Transfer import preserves both owned and foreign UIDs. Provider and consumer
  roadmaps may therefore be transferred in either order: unresolved references
  begin resolving when the provider is imported.

No restore, duplicate, or import resolves an external source as a transaction
precondition. Missing, unpublished, or inaccessible sources affect only the
returned availability state and warnings.

### Notifications

SSE doorbells remain roadmap local: modifying an integration milestone
or its roadmap does not notify other roadmaps. Adding a dependency on
an integration milestone does not notify the owning roadmap of the milesone.
