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

There is exactly one **authoritative integration milestone**, owned and planned
by its source roadmap. A consuming roadmap represents it with a special local
milestone called a **mirror**.

A mirror is not a copy of the provider's plan. It is a consumer-owned reference
with two kinds of fields:

* the consumer owns its lane, title and description, so it can explain the
  integration point in the language and context of its own plan;
* the provider owns the effective date and tentative state, which are resolved
  from the source integration milestone.

The consumer may move, rename, describe or remove its mirror, but it cannot
locally reschedule it or change its tentative state. The provider's source title
and description may be shown as read-only provenance, but they do not overwrite
the mirror's consumer-authored title and description.

The consumer also owns every dependency from the mirror to its local work. A
mirror may exist without a dependency: first the user brings an integration
milestone onto a lane, then decides which local work actually depends on it.

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

1. Every stored milestone row belongs to exactly one roadmap. An external
   mirror is a local milestone that softly references one authoritative source
   milestone by UID.

2. A milestone must explicitly be declared an **integration milestone** before entities in other roadmaps may depend on it.

3. The local prerequisite of a cross-roadmap dependency is a mirror of an
   integration milestone in another roadmap.

4. The dependent entity of a cross-roadmap dependency must be an item, not a milestone.

5. An integration milestone's own prerequisites belong to its owning roadmap.

6. A mirror cannot itself be an integration milestone, cannot depend on
   anything, and cannot be the prerequisite of another milestone. These rules
   prevent chains of mirrors from becoming a global milestone graph.

7. A consuming roadmap may contain at most one mirror of a given source
   milestone.

8. A dependency on an external source cannot exist without its mirror being
    present on the consuming roadmap. Removing the mirror removes its local
    dependencies.

These rules can be summarized as:

> **Milestones export; items import.**

## Lifecycle

Once another roadmap depends on an integration milestone, the owning roadmap
must be shown the impact before invalidating that contract.

At minimum, Roadie should prevent or explicitly handle:

* deleting the milestone,
* removing its integration-milestone status.

Rescheduling or changing the tentative state remains the responsibility of the
owning roadmap and propagates to consumers. Renaming or redescribing the source
does not replace a mirror's consumer-authored text, although current source
details may be shown alongside it as provenance.

An integration milestone should expose actual consumers through a derived view
such as:

```text
Used by 4 roadmaps
```

This count is derived from dependencies, not merely from mirrors: showing a
milestone for context is not yet relying on it. A separate `Shown on N
roadmaps` fact could be derived if it proves useful, but it is not the
project-management relationship.

Deleting the source milestone, removing its integration status, trashing its
roadmap or making it inaccessible does not delete consumer mirrors or their
dependencies. They become broken references which remain visible and
actionable in the consuming roadmap.

## Design Intent

This feature is explicitly **not** intended to make all Roadie entities globally linkable.

The purpose is to provide a small, controlled interface between otherwise independent plans.

Roadmaps expose a handful of meaningful **integration milestones**. Other roadmaps can consume those milestones where their own work genuinely depends on them.

This preserves local roadmap ownership while allowing program-level coordination without dependency spaghetti.

## Implementation

Add two fields to `milestones`:

```sql
integration_milestone BOOLEAN NOT NULL DEFAULT false,
source_milestone_uid  UUID
```

A null source UID means an owned milestone; a non-null value means a mirror.
The source UID is an indexed soft reference. A mirror owns its lane, title and
description, but cannot itself be an integration milestone.

Keep `date` non-null. For a mirror it is a non-editable last-known source date,
initialized on creation and refreshed while the source is valid. This keeps a
broken mirror at a stable timeline position. Store `tentative = false` on the
mirror; when resolved, return the source's current tentative value.

Keep dependencies in the existing table:

```text
consumer mirror milestone → consumer item
```

Both endpoints are local. A mirror may only be a prerequisite of a local item;
it cannot be a dependent or point to a milestone. Creating the mirror or a new
edge requires an accessible integration milestone in another roadmap. A
roadmap may contain only one mirror per source. Deleting the mirror cascades its
edges.

If the source becomes missing, unpublished or inaccessible, keep the mirror and
its dependencies. Render it at the cached date with a warning, and mark its
dependency schedule unverified. Source resolution must never make roadmap
loading, restore, duplication or import fail.

Mirrors use the ordinary `milestones` API collection and dependencies use the
ordinary `dependencies` collection. Extend the milestone payload with its
derived kind, source UID and resolution state; keep frontend `date` non-null.
The UX is: add a mirror to a lane, then add local dependencies from it.

Mirrors and their edges ride in `RoadmapFull`, snapshots, exports and imports.
Copy generates a new mirror UID but preserves its source UID; transfer preserves
both. Raise `ExportVersion` to 3 and keep `MinExportVersion` at 2.
