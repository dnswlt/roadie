# Jira reconciliation

Roadie and Jira serve different purposes. A roadmap describes the plan: its
significant outcomes, intended timing, structure, and dependencies. Jira tracks
the work that executes that plan. Roadie keeps these models separate instead of
trying to make either system a copy of the other.

The plan still needs traceability to execution. A Roadie item can therefore
reference one or more Jira issues by including their URLs in its description.
These references are deliberately shallow. Roadie does not synchronize Jira
status, dates, estimates, progress, or hierarchy, and Jira needs no
Roadie-specific fields or configuration.

Jira reconciliation uses these references to answer two questions:

- Which issues in a chosen Jira result set have no reference from this roadmap?
- Which Roadie items have no Jira reference?

The lists identify relationships to review; they do not declare that either
system is wrong. Roadie reads the Jira issues needed for the review but never
creates or updates them.

The **Jira Recon** view is available when the Roadie deployment has a Jira
connection and a roadmap is open. Select **Jira Recon** in the top bar, or press
`r`, to open it.

## How matching works

Roadie recognizes HTTP or HTTPS issue URLs from the connected Jira deployment
in item descriptions. It extracts the issue key from each URL and matches keys
case-insensitively. A similar-looking link to another Jira host does not count.

The relationship is many-to-many: an item may reference several issues, and an
issue may be referenced by several items. Parent and child items are checked
individually. Milestones do not participate in reconciliation.

## Define the Jira scope

A roadmap usually needs to account for only a subset of the issues in Jira.
The JQL query defines this Jira-side scope using fields the team already
maintains, such as project, release, component, or initiative. Prefer to build
and test substantial queries in Jira, then paste them into Roadie.

Saved queries belong to one roadmap and are not shared with other roadmaps.
Saving a query makes its Jira scope reusable without attaching a fixed set of
issues: each run retrieves the issues that currently match the JQL.

1. Enter the JQL to save.
2. Select **Save query**, enter a name, and select **Save**.

Select **Saved** to load and run a saved query. The same menu provides actions
to rename or delete it. If you load a saved query, change its JQL, and save it
under the same name, Roadie updates the saved query. Saving it under a different
name creates another one.

> **Note:** Saved queries are reconciliation settings. They are not included in
> roadmap exports or version history.

## Review Jira issues

The **Jira issues** tab searches Jira using JQL:

1. Enter a JQL query.
2. Select **Run**.
3. If Jira has more results, select **Load more** to append the next page.

Each result shows the issue key, summary, type, and status. Select the issue key
to open it in Jira. When Roadie items already reference the issue, their titles
appear below it; select a title to open that item in the edit panel.

Select **Unmatched** to show only issues with no matching Roadie item. The
filter applies to the results loaded so far, not to pages that have not yet been
loaded. The count below the list shows how many issues are loaded and whether
more results are available.

## Review Roadie items

The **Roadie items** tab lists items whose descriptions contain no recognized
Jira issue URL. This list is independent of the JQL query on the **Jira issues**
tab.

Select an item to open it in the edit panel.

## Link an issue and an item

You can start from either tab:

- On **Jira issues**, select the plus button for an issue, then find and choose
  a Roadie item.
- On **Roadie items**, select the plus button for an item. Roadie opens the
  **Jira issues** tab; run or refine the query, then select **Link** beside the
  required issue. Select **Cancel**, or press `Esc`, to stop without linking.

Linking appends the Jira issue URL to the Roadie item's description. Existing
description content is preserved.
