# Integration milestones

Roadmaps often rely on outcomes planned elsewhere. Work in one roadmap may not
be able to finish until a milestone in another has been reached.

Copying the expected date into each roadmap creates several versions of the
same milestone, which can drift apart. Combining all the related work into one
roadmap makes that roadmap too broad. Integration milestones provide a third
option: keep the plans separate and link the milestones they share.

## How integration milestones work

Any roadmap can make selected milestones available as **integration
milestones**. Other roadmaps can link those milestones into their own plans and
make local work depend on them.

For example, a platform roadmap contains **API available**. A product roadmap
links that milestone and makes **Release mobile app** depend on it. If the API
date changes on the platform roadmap, the linked milestone moves on the product
roadmap as well.

The two milestones have different roles:

- The **integration milestone** is the source. Its roadmap sets the date and
  whether the date is tentative.
- The **linked milestone** represents the source in another roadmap. That
  roadmap chooses the context, title, and description, and connects it to local
  work.

A roadmap can offer several integration milestones and link milestones from
several other roadmaps. There is no master roadmap: each roadmap maintains the
milestones it offers and uses the milestones it needs.

The source and linked milestone form an integration seam: one named handoff
between two plans. Nothing else from either roadmap is copied across that seam.

## When to use one

Use an integration milestone when:

- an outcome in one roadmap is a prerequisite for work in another;
- one roadmap clearly owns the outcome's timing;
- both roadmaps need to show the same expected date;
- a change to that date matters to the other roadmap.

**Payments API available** and **Regulatory approval received** are good
examples: each describes an outcome that another plan can depend on.

A simple test is to ask: if this date moved, would another roadmap need to
reconsider its plan? If so, the milestone may be a useful integration seam. If
the milestone is merely interesting background information, a link in the
description is usually enough.

Do not make every internal checkpoint an integration milestone. Other roadmaps
need the handoff, not the work breakdown behind it.

## Make an integration milestone

1. Open the roadmap containing the milestone.
2. Select the milestone and open its edit panel.
3. Under **Metadata**, select **Integration milestone**.
4. Confirm the change.

The milestone can now be found and linked from other roadmaps. It may still be
tentative; that tells consumers that the date is an estimate.

## Link an integration milestone

1. Open the roadmap that needs the milestone.
2. Open the menu for the context where it belongs.
3. Select **Link ext. milestone**.
4. Search for the milestone and select it.

Roadie adds a linked milestone to the chosen context. Rename or describe it to
fit the local plan, then use **Dependencies** to make local items depend on it.
Its date and tentative state continue to come from the integration milestone.

A roadmap can link a particular integration milestone only once. Several local
items can depend on that one linked milestone.

## See where a milestone is used

A linked milestone shows its **Source milestone** under **Dependencies**. The
source provides the current date and tentative state.

An integration milestone shows **Used by** under **Dependencies**. This lists
the roadmaps that have linked it and the linked milestone in each one. A roadmap
appears as soon as it links the milestone, even if no local item depends on it
yet.

## Change an integration milestone

The roadmap containing the integration milestone can change its date or
tentative state as the plan develops. Linked milestones receive those changes.
Their local titles and descriptions are not replaced.

Before changing the date, check **Used by** to see which other roadmaps contain
the milestone.

## Remove an integration milestone

Removing integration status, deleting the milestone, or deleting its roadmap
makes the source unavailable. Roadie warns before removing or deleting an
integration milestone that other roadmaps use.

Linked milestones are not deleted. They keep their last known date and their
local dependencies, and show **Source unavailable**. This warning means that
the shared date is no longer being maintained; it does not mean that the
milestone was reached.

When possible, review **Used by** before removing the integration milestone.
Roadmaps using it can remove their linked milestones or replace them with
another source.

## Visibility

A roadmap must be public to offer or link an integration milestone. Making the
roadmap containing the source private makes that source unavailable, but does
not delete linked milestones from other roadmaps. Only public roadmaps appear
under **Used by**.

Public means visible and editable, not read-only. See [Sharing and
collaboration](managing-roadmaps.md#sharing-and-collaboration) for the roadmap
visibility model.
