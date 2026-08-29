# Schedule check

A Roadie item and its linked Jira issues describe the same work at different
levels. Their dates can drift apart: Jira may schedule an issue before its
Roadie item starts or after it ends, or the two systems may assign different
planning periods.

**Schedule check** fetches the linked issues from Jira through its REST API,
extracts their planned dates, and compares them with the dates of the Roadie
items that link to them. It lists the differences for review. It never changes
the roadmap or Jira automatically.

Schedule check uses Jira links already present in item descriptions. It does
not use the JQL or results from the **Jira issues** tab. Milestones are not
included.

Open a roadmap, select **Jira Recon**, then select **Schedule check**. The view
is available when the Roadie deployment has a Jira connection.

## Tell Roadie where Jira keeps its schedule

Jira has no universal fields for an issue's planned start and end. One
deployment may use date fields, another fix versions, and another a custom
field containing a sprint or named planning period. Their JSON structures can
also differ.

Each roadmap therefore has an **extractor script**. The script is written in
[Starlark](https://starlark-lang.org/), a small Python-like language. It
receives one Jira issue as decoded JSON and returns either dates or roadmap
schedule-period names. Starlark uses familiar Python syntax, but has no imports
or access to files or the network.

An extractor has two main parts:

```python
JIRA_FIELDS = ["customfield_10430", "duedate"]

def get_issue_time_range(issue):
    # Read issue["fields"] and return its schedule.
    return None
```

### Choose the Jira fields

`JIRA_FIELDS` lists the Jira field IDs that Roadie should request for each
issue. Use Jira's IDs, not its display names:

- system fields use names such as `duedate` or `fixVersions`;
- custom fields use IDs such as `customfield_10430`, even when Jira displays
  them as *Planned start* or *Target quarter*.

Roadie always requests `summary`, `issuetype`, and `status`; you do not need to
include them in `JIRA_FIELDS`. Jira also supplies the issue's top-level `id`
and `key`. Add every other field read by the script to `JIRA_FIELDS`.

Find the field IDs in Jira's issue JSON or field configuration. Then open
**Extractor script and test**, enter a representative issue key, and select
**Test**. The test result includes the raw Jira JSON requested by the current
script, so you can confirm the structure and values that the extractor will
receive.

### Limit the Jira projects

By default, the check includes linked issues from every Jira project. Set
`JIRA_PROJECTS` when only some projects use the schedule fields described by
the extractor:

```python
JIRA_PROJECTS = ["PAY", "OPS"]
```

The entries are project keys, without issue numbers. Omit the setting or use an
empty list to include every linked issue.

### Extract the issue schedule

Roadie calls `get_issue_time_range` with the issue JSON. The function returns a
dictionary with one or more of these values:

| Value | Meaning |
| --- | --- |
| `start` | Planned start as `YYYY-MM-DD` |
| `end` | Planned end as `YYYY-MM-DD` |
| `startPeriod` | Name of the roadmap period that supplies the start |
| `endPeriod` | Name of the roadmap period that supplies the end |
| `label` | Optional description of where the schedule came from |

A script may return only a start or only an end when that is all Jira records.
It may also combine a date on one boundary with a period on the other. It must
not return both a date and a period for the same boundary.

Period names must match the current roadmap schedule exactly, including case.
`startPeriod` uses the first day of the named period; `endPeriod` uses its last
day.

Return `None` when an issue should not be compared—for example, when it has no
schedule or its issue type is outside the planning scope.

## Examples

### Extract start and end dates

This example assumes a Jira administrator has created two date fields displayed
as *Planned start* and *Planned finish*. In this Jira deployment, their field
IDs are `customfield_10430` and `customfield_10431`, so the issue JSON has this
shape:

```json
{
  "fields": {
    "customfield_10430": "2026-09-07",
    "customfield_10431": "2026-10-16"
  }
}
```

The display names and field IDs are examples; replace them with the fields your
Jira deployment uses for planned dates.

```python
JIRA_FIELDS = ["customfield_10430", "customfield_10431"]

def get_issue_time_range(issue):
    fields = issue["fields"]
    return {
        "start": fields.get("customfield_10430"),
        "end": fields.get("customfield_10431"),
        "label": "Jira planned dates",
    }
```

If both fields are absent or `null`, Roadie has no dates to compare and skips
the issue.

### Extract a roadmap period

This example assumes Jira labels such as `2026/Q3` use the same names as the
roadmap periods:

```json
{
  "fields": {
    "labels": ["2026/Q3", "2026/Q4", "customer-facing"]
  }
}
```

The script uses the earliest matching quarter as the start and the latest as
the end:

```python
JIRA_FIELDS = ["labels"]

def get_issue_time_range(issue):
    labels = issue["fields"].get("labels") or []
    quarters = []
    for label in labels:
        if len(label) == 7 and label[4:6] == "/Q" and label[6] in "1234":
            quarters.append(label)
    if not quarters:
        return None
    quarters = sorted(quarters)
    return {
        "startPeriod": quarters[0],
        "endPeriod": quarters[-1],
    }
```

The values `2026/Q3` and `2026/Q4` must also be exact names of periods in the
Roadie schedule.

## Test and save the extractor

Use **Test** with several representative issues before saving the extractor:

- an issue with a complete schedule;
- an issue with one missing boundary;
- an issue that should be skipped;
- each Jira issue type whose field structure differs.

The test runs the current editor contents, so you can refine the script before
saving it. Check both the extracted result and the raw JSON. A successful
result only proves that the script can read that issue; it does not prove that
the chosen fields carry the schedule your roadmap intends to compare.

## Review schedule differences

Once the extractor is saved, select **Fetch issues**. Roadie fetches each
in-scope Jira issue linked from an item in the roadmap and applies the
extractor. This refresh runs in the background because a roadmap may link many
issues. You can continue working while it runs. After it completes, use the
circular-arrow button to refresh the result list.

For each link, Roadie checks whether the issue schedule fits within the item's
dates. It lists only mismatches; other outcomes are summarized separately.

Use the list to decide which plan needs attention. You may update Jira, adjust
the roadmap, or leave the difference in place when it is intentional. Roadie
does not choose between those actions.
