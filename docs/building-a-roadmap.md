# Building a useful roadmap

A roadmap gives people a shared view of planned changes.
It shows the major results, their expected timing, and the decisions, handoffs,
and dependencies that shape the plan.

This guide explains how to decide what belongs in Roadie and how to describe it
at a consistent level of detail.

## Define the roadmap's purpose

Before adding contexts and items, decide:

- **Audience** — who will use this roadmap?
- **Horizon** — what period does it cover?
- **Purpose** — which conversations or decisions should it support?
- **Organizing principle** — what do its contexts represent?

For example:

> This roadmap helps the programme leadership team coordinate the major
> results and external handoffs needed for the 2027–2029 platform renewal.
> Contexts represent strategic workstreams, not delivery teams.

The same work may need different roadmaps for different audiences. A leadership
roadmap and a delivery-team plan should not contain the same level of detail.

## Use consistent terms

Roadie deliberately has few entity types. Other planning terms remain useful,
but they do not all belong on the timeline.

| Term | Meaning | Where it belongs |
| --- | --- | --- |
| **Roadmap** | A bounded view of intended change over a stated horizon | One Roadie roadmap |
| **Objective** | The direction or benefit the roadmap is intended to advance | Supporting documentation |
| **Context** | A lane that groups items and milestones using the roadmap's organizing principle | A Roadie context |
| **Workstream** | A sustained, coordinated line of change containing several results | A context when workstreams organize the roadmap |
| **Item** | A meaningful result that takes time to achieve and matters to the wider plan | A Roadie item |
| **Child item** | A substantial part of a result whose timing or dependencies matter separately | A child item |
| **Milestone** | A point-in-time decision, event, approval, or handoff | A Roadie milestone |
| **Integration milestone** | A milestone published for other Roadie roadmaps to rely on | The providing roadmap, linked into consuming roadmaps |
| **Key result or measure** | A target or other evidence that shows whether an item achieved its intended result | The item's description |
| **Theme** | A classification that cuts across the roadmap | A label |
| **Activity or task** | Work undertaken to produce a result | Usually outside the roadmap |

## Organize contexts consistently

A context forms a lane for related items and milestones. All contexts in a
roadmap should follow the same organizing principle.

For a multi-year strategic roadmap, contexts often work well as
**workstreams**. A useful workstream:

- remains meaningful for a substantial part of the roadmap horizon;
- contains several sequential or overlapping results;
- represents a coherent body of change; and
- has recognizable ownership or governance, even when several teams
  contribute.

Examples include **Platform renewal**, **Customer migration**, **Operating
model**, and **External readiness**.

Choose the principle that best supports the roadmap's purpose. Use labels for
cross-cutting themes or contributing teams.

## Model meaningful results as items

An item represents a result that takes time to achieve and matters to the wider
plan. Its finish is recognizable, and its timing, priority, or dependencies
deserve separate attention.

A result matters at roadmap level when one or more of these statements are
true:

- Its timing affects another part of the plan or an external commitment.
- Leaving it out would change the roadmap's scope or direction.
- Completing it is recognizable progress towards the roadmap's objective.

### Define a clear finish

People familiar with the work should be able to agree whether the result has
been achieved. The result need not have a numeric target, but it should be more
specific than a direction or an ongoing concern.

Ask:

> What will be true when this work is finished?

If there is no clear answer, you may be describing a context, theme, activity,
or objective rather than an item.

## Name the result, not the activity

Write the title as a concise statement of what will be true when the work is
finished.

| Instead of | Prefer |
| --- | --- |
| Platform modernization | All tier-1 services run on the supported platform |
| Improve reliability | Critical customer journeys meet the recovery standard |
| API work | Partner API available for production integration |
| Customer migration | All active customers migrated from the legacy service |
| Project Phoenix | Legacy settlement platform retired |

Use the description to explain why the result matters and how people will
recognize its completion. Include any key result, target, or other measure that
will show whether the result was achieved. The description can also identify
scope boundaries and link to supporting material or delivery work.

## Use child items selectively

A child item identifies a substantial part of a result whose timing, priority,
risk, or dependencies need separate attention. Do not use child items as a
task list.

Keep a detail in the task tracker when the roadmap audience does not need to
consider its timing, priority, risk, or dependencies separately.

Roadie allows one level of child items. If that is not enough, reconsider the
parent's scope or whether the detail belongs on this roadmap.

## Use milestones for significant events

Use a milestone for a significant event at a single point in time, such as a
decision, approval, interface freeze, release, handoff, or external event.

When another Roadie roadmap owns the event and other plans may rely on it, the
owning roadmap can make it an integration milestone. A consuming roadmap links
the milestone and connects it to local work.

For an event owned by a vendor, regulator, or another party that does not plan
in Roadie, use an ordinary milestone. Name the observable event, link its
source in the description, and update it when the external plan changes.

## Show uncertainty honestly

Long-range dates become less certain as the plan extends into the future. Mark
an item or milestone as tentative when its timing is an estimate rather than a
commitment. Mark it at risk when its dates are still the plan but something
threatens them.

## Check the roadmap as a whole

Before using the roadmap for a planning discussion, ask:

- Do all contexts use the same organizing principle?
- Are sibling items at comparable levels, and do they describe results rather
  than activities?
- Does the roadmap contain the important decisions, handoffs, and dependencies
  at the level of detail its audience needs?

The goal is not an exhaustive inventory. The roadmap is complete enough when it
supports the decisions and coordination it was created for.
