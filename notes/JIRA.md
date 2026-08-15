# Jira reconciliation

## Intent

Roadie may help reconcile a roadmap with Jira, but it does not synchronize the
two systems. Jira remains the execution tracker and Roadie remains the place for
the high-level plan.

The connection is deliberately asymmetric and read-only:

- Roadie reads Jira issues returned by user-supplied queries.
- Ordinary Jira URLs in Roadie item descriptions express the correspondence.
- Roadie never creates or updates Jira issues.
- Jira needs no Roadie custom fields, backlinks, or other Roadie-specific
  configuration.
- Jira hierarchy, status, dates, estimates, and progress are not imported into
  the Roadie model.

The feature answers two separate questions:

1. Which issues in a chosen Jira result set are represented in this roadmap?
2. Which Roadie items have neither a Jira reference nor an explicit reason not
   to need one?

Neither list declares that one system is correct. It gives a person a small set
of discrepancies to review.

Reconciliation covers Roadie items only. Milestones and links in milestone
descriptions do not participate.

## Jira Recon view

Jira Recon is a separate page or view for the current roadmap. It does not add
Jira state to the timeline or WBS.

The user-facing and deployment-specific implementation is for Jira Data Center,
but the reconciliation model is tracker-agnostic: query for external work
records, page through them, normalize their identity and display fields, and
compare their links with Roadie items. Jira response types and JQL mechanics
should stay behind a small backend adapter rather than enter the Roadie model or
frontend state.

This is an architectural boundary, not a promise of multiple tracker providers
in the first release. There is one configured Jira Data Center deployment and
the UI may call the feature Jira Recon. The goal is simply to avoid making the
generic reconciliation logic Jira-specific when the required functionality is
not.

### Jira issues

The first list is driven by a JQL query. A user can:

- enter and run an ad hoc query;
- save the current query as a favourite;
- name, rename, update, and delete favourites;
- rerun a favourite.

Query favourites should have lightweight UX: a small picker plus the query
editor, not a query-management subsystem. They are connection settings rather
than roadmap content and should not be included in roadmap snapshots or
exports. Favourites are stored in a separate table and scoped to a roadmap.

Results show enough Jira data to identify an issue, initially its key, summary,
issue type, and status. Results have no product-level total cap. Running a query
fetches one Jira page. A **Load more** action fetches the next page and appends
it to the issues already loaded. Roadie never fetches another page
automatically, so one user action cannot accidentally download the whole Jira
deployment while a legitimate result set of any size remains accessible.

The backend is a thin paging wrapper: it returns one page of issues and an
opaque continuation cursor when more are available. The browser does not need
to know Jira's paging mechanism. Starting or rerunning a query clears the
loaded results; changing the query invalidates its old cursor.

For each issue, Roadie extracts its key from Jira URLs in all item descriptions
and reports the Roadie items that reference it. A filter chip toggles between:

- all query results; and
- only issues with no matching Roadie item.

The filter applies locally to all issues loaded so far; it does not fetch ahead
to fill the filtered list. The UI makes that scope clear, for example: “27
unmatched among 300 loaded issues.” A user who needs complete reconciliation
loads the remaining pages explicitly.

Opening an issue goes to Jira. Opening a match selects the Roadie item. The
first version does not write a link into either system from this view; users add
Jira URLs through the existing Roadie description field.

The query defines the Jira universe. Roadie does not require a
`Roadie_enabled` label or attempt to infer which of hundreds of Jira issues are
strategically relevant. Teams can express that scope using whatever Jira fields
already carry meaning for them: issue type, project, release, component,
initiative, or an existing portfolio marker.

### Roadie items

The second list is independent of the active Jira query. It shows every Roadie
item that:

- contains no recognized Jira issue URL; and
- has not explicitly been ignored for reconciliation.

This is intentionally a reference-presence check, not a claim that a Jira issue
matching some query exists for the item.

Each row opens the item and offers a cheap **Ignore for Jira Recon** action.
Ignored items move to a separate list on the same page. That list is collapsed
by default, displays its count, and makes restoring an item to the active list a
single action. Keeping ignored items visible and reversible prevents the ignore
mechanism from becoming an invisible graveyard.

Children are checked individually: a link on a parent does not silently cover
its children, and vice versa. This keeps the rule mechanical and avoids
importing Jira or Roadie hierarchy semantics into reconciliation. We can revisit
this if real roadmaps produce excessive noise.

## Ignored Roadie items

Ignored items are stored as explicit reconciliation state in a separate backend
table. The table associates an item with its roadmap and exposes atomic ignore
and restore operations. It cascades on item deletion.

This state does not use a reserved label. Ignoring an item is a decision owned
by Jira Recon rather than a classification of the roadmap item, and keeping it
separate avoids magic label semantics and concurrent whole-array label updates.

Ignore state lives outside the `RoadmapExport` envelope. Restoring the plan does
not restore an old reconciliation inbox. No reason, expiry, or workflow state
is needed initially; the visible ignored-items list provides reviewability.

## Matching rules

Initially, a Roadie item matches an issue when its description contains a
recognized HTTP(S) Jira issue URL whose issue key equals the Jira result key.
Matching is case-insensitive for the key and exact after normalization.

The Jira base URL configured for the connection determines which links count as
Jira links. Links to unrelated hosts that merely contain `/browse/ABC-123` must
not count. Existing external-link behavior remains unchanged when no Jira
connection is configured.

The correspondence is many-to-many: several Roadie items may reference the same
Jira issue, and one Roadie item may reference several Jira issues. Duplicate
references are therefore neither errors nor a separate report condition.

## Configuration and operational boundary

A Roadie deployment connects to one Jira deployment. The connection needs its
base URL and read-only authentication. Credentials are deployment secrets,
never roadmap fields, exports, or snapshots. Access must be limited to Jira
search and issue reads.

Saved query favourites live in their own backend table and belong to one
roadmap. Like ignore state, they are operational reconciliation data rather than
roadmap content and remain outside snapshots and exports. Deleting a roadmap
deletes its saved queries.

The first version runs queries explicitly. It may cache results briefly. It has
no polling, webhooks, background reconciliation, notifications, or automatic
mutations.

## Jira Data Center REST surface

The concrete adapter uses only two Jira Data Center REST API v2 operations:

- `POST /rest/api/2/search` for paged JQL queries, requesting only `summary`,
  `issuetype`, and `status`;
- `GET /rest/api/2/issue/{issueIdOrKey}` for optional one-off issue resolution.

The backend hides Jira's `startAt`/`maxResults` paging and maps responses to a
small tracker-neutral issue representation. No Jira write, saved-filter,
hierarchy, transition, or remote-link API is required. These operations were
validated against Atlassian's Jira Data Center REST documentation.

## Suggested delivery slices

1. Add connection configuration and read-only ad hoc JQL search.
2. Extract and index Jira references from the current roadmap, then add the
   matched/unmatched Jira result filter.
3. Add the independent unreferenced Roadie item list and reviewable ignore
   state.
4. Add lightweight saved-query CRUD.
5. Based on usage, consider stale or inaccessible-link reporting.

Success means a planning conversation can answer “what is unaccounted for?” in
a few minutes without turning Roadie into a Jira dashboard or requiring Jira
administrators to model Roadie inside Jira.
