# Key concepts

Roadie uses a small set of concepts to describe what is planned, when it is
expected, how larger outcomes break down, and what depends on what. This page
introduces those concepts and how they fit together.

## Roadmaps

A **roadmap** is a self-contained plan. You might create one for a product, a
system, a programme, or a team. Roadie can hold many independent roadmaps.

A roadmap organizes items and milestones into contexts. It may also define a
schedule and dependencies between its items and milestones.

→ [Managing roadmaps](managing-roadmaps.md)

## Contexts

A **context** groups work by an enduring concern that helps readers understand
the plan—for example a product area, subsystem, or team. Every item and
milestone belongs to a context.

Each context has a colour that identifies its items and milestones throughout
Roadie.

## Items and child items

An **item** is a result, capability, undertaking, or other meaningful part of
the plan. It has:

- a title and description;
- an inclusive start and end date;
- optional priority and labels;
- an optional attention flag;
- optional planning signals for tentative timing and risk;
- optional dependencies on other items or milestones.

An item may have **child items**, providing one deliberate level of
decomposition. Child items have their own dates and attributes. The hierarchy
stops there: a child item cannot have children of its own. This is deliberate:
deeper hierarchies tend to turn a roadmap into a nested task tracker, obscuring
the outcomes and relationships the roadmap is meant to communicate.

## Milestones

A **milestone** marks a significant date: a decision, release, review, handover,
or other event with no duration. Unlike an item, it is a point in time rather
than work spanning a period. Its date may be tentative, shown as a hollow
diamond.

Milestones can participate in dependencies, so a plan can express that an item
must finish before a decision date, or that later work depends on a milestone.

## Integration milestones

An **integration milestone** is a milestone made available to other roadmaps.
Those roadmaps can link it into their own plans and make local work depend on
it.

Together, the integration milestone and its links form an **integration seam**:
an explicit handoff between independently maintained plans. Integration seams
are a key ingredient in making planning scale. Each roadmap can stay focused
while still showing where it connects with others, so work can span many
planning scopes without one roadmap containing all of it.

→ [Integration milestones](integration-milestones.md)

## Views

Roadie offers two views of a roadmap. The **timeline** emphasizes when things
are planned: item bars span their planned dates, milestones appear at their
dates, and contexts form horizontal swimlanes.

The **Work Breakdown Structure (WBS) view** emphasizes structure. It shows the
same content as an ordered hierarchy, making context membership, parent-child
relationships, labels, and ordering easier to scan.

## Schedule

Roadie can organize a roadmap directly by calendar periods, using days, weeks,
months, or quarters as its time grid.

Organizations that plan to their own rhythm can define a sequence of named
**schedule periods**, such as sprints or Planning Intervals (PIs). Items retain
their calendar dates, while the schedule relates those dates to the
organization's planning cadence.

## Dependencies

A **dependency** is a directed relationship between two items or milestones:
the dependent needs the prerequisite. Roadie keeps one dependency kind—there
are no edge types, lag values, or labels—and prevents dependency cycles.

Because an item typically describes an outcome, a dependency reads as "B is not
achieved until A is", rather than "B may only start once A is finished":
dependent work routinely overlaps its prerequisite.

Roadie therefore warns only when a prerequisite is scheduled to finish after the
work depending on it, not when the two merely overlap. It never reschedules the
plan automatically.

Roadie shows an entity's immediate prerequisites and dependents, never the
whole graph at once. A chain is followed by moving from one entity to the next,
which is what keeps the plan free of a spaghetti of dependency lines.

## Metadata

Roadie keeps metadata deliberately limited:

- **Priority** is an optional P1–P4 ordering signal, with P1 highest. It says
  that an item matters more or less relative to other roadmap items; it is not
  execution status.
- **Labels** are free-form terms shared across a roadmap. They classify items
  and can be used to filter the current view down to them.
- A **flag** means that an item needs human attention. It is intentionally a
  single, lightweight marker with no type, owner, due date, or workflow.
- **Tentative timing** means that an item's dates or a milestone's date are an
  estimate rather than a commitment—typically when planning is distant or not
  yet well understood. The timeline draws tentative items with ragged ends and
  milestones as hollow diamonds. The WBS uses "≈" for both and also keeps the
  hollow milestone diamond.
- **At risk** means that an item's dates are still the plan, but something now
  threatens them. It is shown as a warning triangle.

An item can be tentative, at risk, and flagged at the same time. Each signal is
a yes or no with no further detail: Roadie has no confidence percentages and no
*off track*, *blocked*, or *done* states.

Roadie does not track execution progress. Percent complete and task states
belong in work-tracking systems, not in the roadmap itself. These signals say
how much to trust the plan, not how much of the work is done.

## External references

Items and milestones can reference Jira issues, documents, and other external
resources by including links in their descriptions. For items, the first link
is the primary reference and can be opened directly from the timeline or WBS;
all links remain available when editing the item.

Roadie treats external references as links, not integrations: it does not fetch
status, synchronize another system's hierarchy, or derive roadmap progress from
external tools.

→ [Jira reconciliation](jira-reconciliation.md)
