# Schedule check

Jira Recon's third question, beside the two in notes/JIRA.md: are the Jira
issues linked from a roadmap item still scheduled inside that item's time range?
Same kind of finding, same handling — reported, never resolved, never written
back to Jira.

Jira has no one place where an issue's schedule lives (fix versions, PI labels,
Begin/End custom fields, sprints). Instead of a field-mapping UI, a roadmap
carries a small **extractor script** in Starlark saying which fields to read and
how to turn them into a date range. Roadie owns everything else, including the
comparison.

## Scope

- A third tab in Jira Recon, not a view beside it. Nothing on the timeline or in
  the WBS: out of scope.
- Items only; milestones don't participate.
- Driven by links already in item descriptions. Running a JQL query does not run
  the extractor; the issues list is unchanged.
- Runs on explicit action. No polling, no run-on-open.

## Extractor script

One optional script per roadmap, in the DB, edited in Recon. Operational config
like saved queries: **outside snapshots and exports**, cascades on roadmap
delete. Named generally — the time range is the first well-known entry point,
not the only conceivable one.

```python
JIRA_FIELDS = ["fixVersions", "customfield_10020"]

def get_issue_time_range(issue):
    if issue["fields"]["status"]["name"] == "Done":
        return None
    versions = issue["fields"].get("fixVersions") or []
    if not versions:
        return None
    v = versions[0]
    return {"start": None, "end": v.get("releaseDate"), "label": v.get("name")}
```

`JIRA_FIELDS` — optional list of Jira field **ids**, passed to Jira untouched.
System fields happen to read well (`fixVersions`, `duedate`), custom fields do
not: it is `customfield_10430`, never `"Begin Date"`. Roadie does not look up
the id behind a display name — that mapping is per deployment and would mean a
`/rest/api/2/field` call and a cache to serve a convenience. The Test panel's
raw JSON is where you find the id. The list is unioned with the display fields
(`summary`, `issuetype`, `status`) so a script can't blank the identity
columns.

`get_issue_time_range(issue)` — `issue` is a plain dict decoded from Jira's JSON
(`issue["key"]`, `issue["fields"]`, nested as Jira returns it); the display
fields are always present, so filtering on status or type needs no
`JIRA_FIELDS` entry.

**It returns a dict, or `None`.** One shape, one decode path, one place to
extend. Keys are all optional:

| Key | Meaning |
| --- | --- |
| `start`, `end` | the range, either end omitted or `None` when unknown |
| `label` | where the dates came from, e.g. `"Sprint 24"`, `"Fix Version 26.3"` |

`None` means **skip this issue** — and so does any dict with no dates in it,
because those say the same thing: nothing to compare. That one rule covers both
uses at once, the filter (`return None` for closed issues, for a type that never
carries dates, for another team's project) and the blank (no fix version set
yet). A separate `ignore` key would only earn its place if it carried a reason,
and it doesn't; a script that wants to explain itself can grow a key later.
Filtering therefore needs no second well-known function either — the decision
falls out of the same fields the range does, in one pass.

An unrecognized key is an error, not silence — `"lable"` or `"ends"` would
otherwise cost an afternoon.

Either end alone is useful: a fix version has a release date and no start.
Dates are `YYYY-MM-DD`; an ISO timestamp is truncated **as written**, never
timezone-converted (that would move a date by a day for unexplainable reasons).
Anything else is an extraction error naming the value.

`label` is provenance, and only the script can supply it: Roadie sees two dates
and cannot know which field they were read from. It turns "ends 12 Apr, item
ends 31 Mar" into "Sprint 24 ends 12 Apr, item ends 31 Mar" — which names what
to go fix in Jira, and exposes a script reading the wrong field, where the date
alone looks perfectly plausible.

Sandbox: plain Starlark is already hermetic — no `load()`, no I/O, no clock, no
recursion, and no `while`, so the loops it can express are finite. The one
remaining accident is a long finite one (`for i in range(10**9)`), which nothing
in the interpreter interrupts, so a per-issue execution step budget
(`SetMaxExecutionSteps`) is the only guard. With `-auth=off` anyone editing a
roadmap can save a script, but that is not a new power: they can already post
arbitrary JQL.

`print()` is captured for the editor rather than the server log — a user
debugging a script shouldn't need shell access.

**No helper builtins in v1.** Regexes — and with them DC's older
`Sprint@1f2f3[startDate=…]` string — are a v2 addition, not a reason to delay
teams on fix versions, labels, or date fields.

**Validation on save.** `PUT` compiles, execs the top level, and checks
`get_issue_time_range` is callable and `JIRA_FIELDS` is a list of non-empty
strings; failure is a 400 with Starlark's message and line, nothing stored. This
lives in the server layer, not the store — it needs the interpreter and is
semantic, like JQL validity. Runtime failure is **per issue**: one raising issue
gets an error state, the rest still render. A check compiles and execs the
script once, then calls the function per issue — no cache across requests, since
compiling twenty lines disappears next to one Jira round-trip.

## Running the check

The frontend keeps link parsing (`links.ts`, `recon-diff.ts`): it collects the
referenced keys and the item each came from, posts the distinct keys, and
compares the returned ranges itself. The backend fetches those issues with
`JIRA_FIELDS ∪ display fields`, runs the extractor, and returns per key the
usual issue projection plus `start`/`end`/`label` or an `error`.

**Deployment identity.** A link counts only when it sits under `trackerUrl` from
`/api/me`, context path included. Already implemented in `recon-diff.ts`.

**Batching.** Chunks of `key in (...)`. JQL rejects the *whole* query when one
key is missing or invisible — and a stale link is exactly what Recon exists to
surface — so a rejected chunk falls back to individual lookups, yielding a clean
per-key "not found". Cap on keys per request.

## Comparison rule

Roadie's, not the script's. Item range is inclusive `[start, end]`; issue range
`[s, e]` with either end possibly unknown. **Doesn't fit** when `s < item.start`
or `e > item.end`, comparing only known ends.

- Overhang only. An issue entirely inside its item is fine however much
  narrower — a sprint inside a quarter is the point.
- Skipped (no range) and extraction errors are distinct states, not warnings.
- No slack setting — a script that wants tolerance pads the range it returns.
- Judged per `(item, issue)` pair; an item is flagged if any of its issues
  overhangs. Many-to-many stays many-to-many.

## In Recon

Third tab, with a count once run. Two parts:

- **Results** — one row per checked item: its range, each linked issue with the
  extracted range and label. Every checked issue shows its range, not just the
  failures: that is how a script gets debugged. A filter chip narrows to
  mismatches, worded like the existing ones ("6 outside range among 41
  checked, 12 skipped"). Skipped issues stay in the count line: a script that
  quietly swallows everything must not read as a clean roadmap.
- **Editor** — source, Save reporting compile errors inline, and Test running
  the *unsaved* source against a named key, showing the result, `print()`
  output, and **the raw JSON of the requested fields**. Without that last part
  nobody can discover that Begin Date is `customfield_10430` here.

No script saved: the tab explains and offers to create one. **No default
extractor** — a guessed field mapping is silently wrong for everyone it doesn't
fit.

## Data model and routes

One table, at most one script per roadmap (unique roadmap id, cascade, source +
timestamps). Migration first, then folded into `schema.sql`. Routes follow the
favourites' shape — `guard`, not `snap`:

- `GET|PUT|DELETE /api/roadmaps/{id}/tracker-extractor`
- `POST /api/roadmaps/{id}/tracker-extractor/test`
- `POST /api/roadmaps/{id}/schedule-check`

Roadmap-scoped, unlike `POST /api/tracker/search`, because the script belongs to
a roadmap.

## Backend

`tracker.Issue` stays neutral; extracted `start`/`end`/`label` are neutral facts
and join it. The script's *input* is not neutral — it reads `customfield_10020`
— so raw fields are a distinct, explicitly Jira-shaped channel reaching the
extractor and the test endpoint only, never the model or frontend state.

The adapter gains extra-field fetch by key; a separate package compiles and runs
Starlark and knows no HTTP; `server/tracker.go` wires them. Adds
`go.starlark.net` to a four-dependency go.mod — canonical, no smaller option, a
deliberate change in posture.

## Slices

1. Table, extractor CRUD with save validation, Starlark runner.
2. By-key fetch (extra fields, chunking, fallback) and the check endpoint.
3. Recon tab: run, render ranges, filter to mismatches.
4. Editor with Test and raw-field inspection.
