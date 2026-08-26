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
| `startPeriod`, `endPeriod` | an exact roadmap schedule-period label; its start or inclusive end supplies that boundary |
| `label` | where the dates came from, e.g. `"Sprint 24"`, `"Fix Version 26.3"` |

`startPeriod` resolves to that period's start; `endPeriod` resolves to its
inclusive end. A boundary has one source: returning both `start` and
`startPeriod`, or both `end` and `endPeriod`, is an extraction error. Direct
dates and period references may otherwise be mixed. Labels match the roadmap's
schedule exactly and case-sensitively, as schedule labels do everywhere else.
After period resolution, a known start must not be later than a known end; that
is a schedule error for the issue, not a failure of the batch.

The frontend resolves period references against the roadmap's current schedule,
beside the item-range comparison that already needs both. No schedule or no
period under the returned label is an error for that issue. It never fails the
batch: Jira labels are free-form, so an unrelated or stale label must not
prevent the other issues from being checked. Editing the roadmap schedule
immediately reinterprets cached period references without another tracker
request.

`None` means **skip this issue** — and so does any dict with neither dates nor
period references in it, because those say the same thing: nothing to compare.
That one rule covers both uses at once, the filter (`return None` for closed
issues, for a type that never carries dates, for another team's project) and
the blank (no fix version or scheduling label set yet). A separate `ignore` key
would only earn its place if it carried a reason, and it doesn't; a script that
wants to explain itself can grow a key later. Filtering therefore needs no
second well-known function either — the decision falls out of the same fields
the range does, in one pass.

An unrecognized key is an error, not silence — `"lable"` or `"ends"` would
otherwise cost an afternoon.

Either end alone is useful: a fix version has a release date and no start.
Dates are `YYYY-MM-DD`; an ISO timestamp is truncated **as written**, never
timezone-converted (that would move a date by a day for unexplainable reasons).
Anything else is an extraction error naming the value.

`label` is provenance for literal dates and optional extra context for period
references. Only the script knows the Jira source. It turns "ends 12 Apr, item
ends 31 Mar" into "Sprint 24 ends 12 Apr, item ends 31 Mar" — which names what
to go fix in Jira, and exposes a script reading the wrong field, where the date
alone looks perfectly plausible.

Plain Starlark is hermetic — no `load()`, I/O, clock, recursion or `while` — but
it is not resource-bounded. A step budget does not bound allocation within one
step, and a deadline cannot interrupt it safely. Resource isolation requires a
separate process. Saving a script is therefore a **trusted action**.

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
gets an error state, the rest still render. A due batch compiles and execs the
script once, then calls the function per issue.

## Running the check

The frontend keeps link parsing (`links.ts`, `recon-diff.ts`): it collects the
referenced keys and the item each came from, and compares the returned ranges
itself. The backend fetches those issues with `JIRA_FIELDS ∪ display fields`,
runs the extractor, and returns literal boundaries and period references.

**Exactly one goroutine performs schedule-check fetches**, process-wide. The two
routes have separate jobs: `POST` enqueues a refresh and `POST .../status` reads
the cache. The client reads the available results once when the view loads.
Fetch issues only schedules work; the circular-arrow action explicitly reads
the available results again. The client does not poll.

The worker serializes tracker traffic; there is no token bucket. The queue is
bounded, and enqueue reports how many distinct keys it covers. A short count
means the backlog is full, and the rest stay unchecked until asked for again.
Enqueue and status responses also report the roadmap's pending key count,
including the active batch, so the client can show ongoing work without polling.

`unchecked` is therefore a statement about Roadie and not about the issue: no
cached result is available for that key.

A batch is one roadmap's keys, so one script and one field set cover it. The
script is read when the fetcher reaches the keys rather than when they were
enqueued, so editing one takes effect on whatever has not run yet.

**Deployment identity.** A link counts only when it sits under `trackerUrl` from
`/api/me`, context path included. Already implemented in `recon-diff.ts`.

**Batching.** Batches of `key in (...)`, 100 keys each. JQL rejects the *whole*
query when any key is missing or invisible, so without salvage one dead link
would cost the caller the other 99 and the check would under-report a roadmap
without saying so. Salvage is not a search: **Jira's 400 names every unknown
key**, once each, in `errorMessages`, single-quoted, and never names a key that
was fine —

```
{"errorMessages":["An issue with key 'RCSAM-170000' does not exist for field 'key'.",
                  "An issue with key 'RCSAM-170001' does not exist for field 'key'."],"errors":{}}
```

— so the batch is retried without the named keys, which then report as not
found. The normal case is two requests regardless of the number of dead links.
Only keys actually sent may be dropped, and a 400 naming none of them is a
different failure (malformed JQL, `key` unavailable). Salvage is capped at three
requests in case a deployment names only one bad key at a time.

Reading the provider's error text is not a new posture — the adapter already
parses this envelope to promote a JQL error into the user's own words.

**A short page is truncation, never a missing issue.** Unknown keys produce a
400, so a 200 must return exactly as many issues as the batch had keys. Anything
less is `jira.search.views.default.max` cutting the page, and reporting the
remainder as dead links would tell a roadmap its live links are broken. It is an
error naming the cap.

100 rather than more: a probe of one Data Center deployment returned 300/300 at
4.5KB of JQL with no cap in sight, but that limit is per installation and Jira
Cloud caps `maxResults` at 100. Since the fetcher is never in a hurry, headroom
above 100 buys nothing and costs portability.

**Freshness is a refresh debounce, not a result TTL.** Results are cached
process-wide with the time each was checked. Status reads return every cached
result, however old; an old answer remains useful while a refresh is pending.
The fetcher skips results checked less than a minute ago, so a person leaning on
Fetch issues — or two people checking the same roadmap — does not spend the
deployment's rate limit twice. Missing results and results at least a minute old
reach Jira.

The cache holds **extracted results, never raw issues**. `JIRA_FIELDS` is
user-supplied and unbounded: a script naming `attachment` or `comment` pulls
documents rather than dates, so caching before extraction would turn a field
list into server memory. Cached results remain compact whatever fields the
script requested. Named period boundaries stay as names in the cache and are
resolved against the current roadmap schedule in the frontend.

Entries are keyed by a **fingerprint of the script source**, which is what makes
that affordable. Extraction depends on the script, and editing one yields a
different fingerprint, so old entries are never consulted again and there is no
invalidation step to remember. Two roadmaps running identical scripts share,
correctly: the same source over the same issue is the same answer. Absence is
cached too, since a dead key is what makes a batch cost two requests instead of
one. Entries remain for the life of the process; each is a compact extracted
result rather than the tracker payload that produced it.

**Rate limiting is the deployment's, and it says so.** A 429 or 503 is honoured
using `Retry-After` when present and a doubling delay otherwise. Each search has
a fixed attempt cap. One 30-second sleep budget is shared by every batch and
salvage round in a `FetchIssues` call. Salvage itself needs no time deadline; its
three-request cap bounds it independently.

**Only the fetcher ever waits.** Waiting is acceptable there because nobody is
watching it and nothing else is delayed by it. The interactive JQL search shares
the same client and must keep failing fast — a person typing a query is told the
tracker is busy, not left on a spinner while a background goroutine's rate limit
is waited out. Backoff therefore lives around the by-key fetch, not in the
adapter's shared request path, and there is no process-wide hold-off: with one
fetcher there is no concurrency to coordinate, and a shared window would only
serve to let background work slow down foreground requests.

A 429 must never be confused with the 400 above: splitting or retrying a
rate-limit rejection multiplies exactly the pressure that caused it.

Nothing races here: one goroutine is the only fetcher, so a key is in flight
once or not at all. The queue is a set, so asking twice enqueues once.

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

- **Results** — only item/issue pairs whose extracted range overhangs the item.
  Successful comparisons collapse to a count of distinct issues and affected
  items. Skipped and unchecked issues are counts, not result rows.
- **Problems** — below the discrepancies, deduplicated by Jira key and split by
  failure kind: script execution, tracker access, schedule resolution and not
  found. Messages are not grouped because their text may contain issue-specific
  data. Each kind shows its first 10 issues and says how many more were omitted.
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
- `POST /api/roadmaps/{id}/schedule-check` — enqueue keys, returns at once
- `POST /api/roadmaps/{id}/schedule-check/status` — read cached results

Issue-key inputs are normalized to uppercase; the two schedule-check routes
also drop duplicates. The frontend trims user input; the backend does not repair
other invalid input.

Roadmap-scoped, unlike `POST /api/tracker/search`, because the script belongs to
a roadmap.

## Backend

`tracker.Issue` stays neutral; extracted `start`/`end`/`label` are neutral facts
and join it. The script's *input* is not neutral — it reads `customfield_10020`
— so raw fields are a distinct, explicitly Jira-shaped channel reaching the
extractor and the test endpoint only, never the model or frontend state.

The adapter gains extra-field fetch by key; `internal/tracker/extractor`
compiles and runs Starlark; `internal/recon` owns the fetcher, its queue and its
cache, and knows neither HTTP nor the database — it is handed a tracker client
and a function returning a roadmap's script. `server/tracker.go` is two thin
handlers over it, since the check's logic has nothing to do with HTTP. Adds
`go.starlark.net` to a four-dependency go.mod — canonical, no smaller option, a
deliberate change in posture.

## Slices

1. Table, extractor CRUD with save validation, Starlark runner.
2. By-key fetch (extra fields, batching, salvage), the fetcher goroutine with
   its cache and backoff, and the enqueue/status routes.
3. Recon tab: Editor with Test and raw-field inspection.
4. Recon tab: run, render ranges, filter to mismatches.
