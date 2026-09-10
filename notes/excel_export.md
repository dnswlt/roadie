# Roadmap Excel Export

A server-rendered `.xlsx` of a whole roadmap: one row per entity, the work
breakdown on the left, a coloured period/month grid on the right. Export only —
nothing reads an `.xlsx` back.

## Scope

The whole roadmap in canonical order: contexts by position, within each its
milestones (by date) then its items (by rank, children after their parent).
Hidden contexts, the item filter and folds are client state and never reach the
server, as for the JSON export; no scope parameters.

Not in v1: native Excel charts, snapshot export, multi-roadmap workbooks.

## Library

`github.com/xuri/excelize/v2` v2.11.0, BSD-3-Clause. Everything below was
verified against it first: date serials with number formats, per-cell fills,
hyperlinks with tooltips, alignment indent, rich text runs, column outline
groups, freeze panes, autofilter, document properties.

Measured cost: seven new modules (`xuri/efp`, `xuri/nfp`,
`richardlehane/mscfb`, `richardlehane/msoleps`, `tiendc/go-deepcopy`,
`x/crypto`, `x/net`), all permissive; `x/text` 0.29 → 0.38; about +5.8 MB of
binary, putting `bin/roadie` near 23 MB.

## Sheets

`Roadmap` (active on open) and `Info`. The header is **row 1** — no title block,
so every row-1-is-the-header reader keeps working. Both tab names are fixed:
Excel caps a tab at 31 characters and rejects `: \ / ? * [ ]`.

`Info` is a two-column block, bold keys: roadmap name, id and UID; `Exported
(UTC)` as a real datetime cell, taken from `Options` so a test can pin it;
counts of contexts, items, milestones, dependencies; the timeline unit; and the
**full schedule** with each period's dates — the timeline names periods by label
and covers only the ones the work reaches, so nothing else carries them.
Document properties get the name, creator and the same timestamp.

## Numbering

Column A is a sheet-local address: positional, unstable across edits, stored
nowhere. Only roadmaps and milestones have a UID, and that stands.

* Contexts: `A`, `B`, … `Z`, `AA`, … — a prefix, never a row of their own.
* Items: `A1`, `A2`. Children: `A1.1`; nesting is capped at one level by the
  store, so there is never a third component.
* Milestones: `A-M1`, a separate sequence so a dependency cell cannot confuse
  one with an item.

## Rows

A flat table: one row per entity, the context name repeated in column B, no
group headers, no row outline. Children indent their name cell with Excel's
alignment indent, not a `"- "` prefix that would end up in a pivot label.

Milestones put their date in both `Start` and `End` — the model's own rule
(`deps-graph.ts`) — and leave `Days` blank.

## Columns

| Col | Header | Notes |
| --- | --- | --- |
| A | WBS | see Numbering |
| B | Context | the lane name, repeated on every row |
| C | Name | title; children indented one level |
| D | Type | `Item` / `Sub-item` / `Milestone` |
| E | Start | real date, `yyyy-mm-dd` |
| F | End | real date, inclusive |
| G | Days | `end - start + 1`; blank for milestones |
| H | Start period | schedule label, blank without a schedule |
| I | End period | ditto |
| J | Priority | number 1–4, displayed `P1` via a custom format so it still sorts |
| K | Tentative | `Yes` / blank |
| L | At risk | `Yes` / blank |
| M | Flagged | `Yes` / blank |
| N | Linkage | `Integration` / `Mirror` for milestones, else blank |
| O | Labels | comma-joined |
| P | Links | see below |
| Q | Description | full text, wrap off |
| R | Depends on | WBS numbers of prerequisites |
| S | Needed by | WBS numbers of dependents |
| T… | timeline | one column per period or month |

`O`–`Q` get a column outline group, so the timeline can be pulled next to the
dates. Freeze after `C` and below row 1; autofilter over row 1.

`Start period` / `End period` name the period the date falls *inside*
(`periodRangeText`'s trade, not `periodAtEdge`'s), blank when it falls in a gap
or outside the schedule. No `~` prefix for a non-flush edge: it would split
`PI 3` and `~PI 3` under a filter, which is what the column is for.

## Links

Descriptions carry links; there is no link field. Column P lists the HTTP(S)
links found in the description, comma-joined, the first attached as the cell's
hyperlink (a cell has only one) and all of them in its tooltip.

Extraction follows `links.ts`: Markdown `[text](url)` first so its target is not
re-emitted as a bare URL, then bare `https?://…` with trailing punctuation
trimmed and balanced parentheses kept. The label is the Markdown text, else the
URL. `linkLabel`'s Jira-shaped shortening is not ported — that knowledge stays
in the tracker packages.

## Dependencies

`Depends on` and `Needed by` list WBS numbers in canonical order (`splitDeps`).
A conflicting edge — prerequisite ends after the dependent, `dateConflict` —
renders that number red, as its own rich text run, on both endpoints' rows.
Red rather than the app's amber: `--danger` is chrome-only *on the timeline*,
and a sheet is not the timeline.

## Timeline

**Extent.** `contentRange` over items and milestones, extended to whole columns.
No padding to today and no empty tail.

**Columns.** With a schedule, one per period, bounded by period *start* dates: a
column runs to the next period's start, and the first and last stretch to the
ends of the content. A gap between periods belongs to the period before it, as
does anything past the last and before the first, so every day is in exactly one
column. Without a schedule, one column per month — or per quarter beyond 48
columns.

**Value.** Overlapping days ÷ days in the column, stored exact, displayed as a
percentage with no decimals, blank at zero. A milestone gets `◆` in its column
instead of the ~3% a single day computes to. A column that absorbed a gap is
longer than its period, so an item filling that period reads below 100%.

**Colour.** The lane's colour blended toward white by the coverage, quantised to
four steps. Needs the six lane hexes in Go, a knowing duplicate of
`web/src/colors.ts`; both sides get a pointer to the other.

Optional: a left border on the column containing today.

## Route

`GET /api/roadmaps/{id}/export.xlsx` — its own route, not a `?format=`
parameter. Under `s.guard(byRoadmapID, …)`, added to `access_test.go`'s
`calls()` table (a coverage check matches it against the registered mux
patterns) and to the `TestRequireClientHeader` table: a safe GET, and a plain
browser navigation that cannot set headers. `exportFilename` grows a suffix
parameter — it hard-codes `.roadie.json` today — and returns `<Name>.xlsx`.
OOXML content type, `Content-Disposition: attachment`.

## Code

New package `internal/sheet`:

```go
func Write(w io.Writer, rm model.RoadmapFull, opts Options) error
```

Pure: no database, no HTTP, no globals. `Options` carries the export timestamp
and the today marker. Numbering, the resolved row model, the column axis and the
style registry are separable, and separately tested.

Dates are written as serial numbers computed from the calendar date (days since
1899-12-30) with a date format, never as `time.Time`: no timezone can shift a
date that never becomes an instant.

## Tests

Go, no database, reading the produced workbook back with excelize:

* numbering: letters past Z, ordinals, children, milestones, an empty context;
* a full row's values, a milestone row, a child row's indent;
* period columns from containment, including a date in a schedule gap;
* the timeline covers the content with no holes — a schedule that starts late,
  stops early and has an interior gap still marks every item, including one
  lying entirely in that gap;
* coverage: partial overlap at both ends, a one-day item, an item spanning
  several columns, a milestone's `◆`;
* dependency cells: order, both directions, red runs on exactly the conflicting
  edges;
* links: Markdown label wins, bare URL trimmed, duplicates collapsed, the cell
  hyperlink is the first;
* `Info`: the timestamp passed in, and a period no work overlaps;
* degenerate inputs: no contexts, no dates, no schedule.

Server: 200, the right content type and filename, bytes excelize can open, plus
the two tables above. Frontend: a `Download as Excel` entry and one action wired
like `exportRoadmap` — nothing to unit-test, it wants an eyeball on the file.

## Sequencing

1. Add the dependency; `internal/sheet` with numbering, rows and the fixed
   columns, plus tests.
2. Schedule columns and the timeline block, with styles and lane colours.
3. Dependencies, links, descriptions.
4. The `Info` sheet and the document properties.
5. Route, filename, access/header tables.
6. Menu entry.
7. One line in AGENTS.md's "Where things live".
