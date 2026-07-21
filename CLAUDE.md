# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
make db-up                # start dev Postgres (container, port 5433 — see below)
make dev                  # esbuild watch + Go server (-dev -seed) on http://localhost:8080
make test                 # Go tests (store tests need the compose DB, skip if DATABASE_URL unset) + frontend tests
make check                # go vet + tsc --noEmit
make build                # production binary (embedded frontend) -> bin/roadie
npm run --prefix web build   # rebuild frontend only (also copies index.html to dist)
npm run --prefix web test    # frontend unit tests only
```

Single Go test: `DATABASE_URL=postgres://roadie:roadie@localhost:5433/roadie go test ./internal/store -run TestItemInvariants`

Frontend tests use Node's built-in runner (`node --test`): `*.test.ts` files live next to their source, are transpiled by esbuild into `web/test-out/` (gitignored), and use `node:test` + `node:assert`. There is no browser/DOM test runner — test pure logic by extracting it into a DOM-free module (e.g. web/src/links.ts ← links.test.ts); exercise DOM/render code in a real browser instead.

Environment quirks (this machine):

- The dev DB is on **port 5433** because a native Postgres already owns 5432. Don't "fix" this back to 5432.
- Docker runs via colima; the Makefile deliberately uses the dashed `docker-compose` binary on macOS (`DC_CMD`) — the `docker compose` plugin is not wired up here.
- `make dev` serves `web/dist` from disk (`-dev` flag); production builds embed it via `go:embed` (web/embed.go). `web/dist/.gitkeep` must exist for the embed to compile.

## Architecture

Single-page roadmap editor. Guiding principle: **radically simple data model; all views are derived from it.**

Model (4 entities, see internal/store/migrations/001_init.sql):
`roadmaps` → `lanes` ("contexts", the swimlanes, ordered by `position`) → `items` (start/end DATE, nullable `parent_id`). Lanes also hold `milestones` (single DATE, title, description — see 005_milestones.sql): fixed points in time, no duration, no rank, not nested, not draggable.

Invariants are enforced in **internal/store** (not triggers, not handlers):

- Item nesting is at most one level deep (a parent cannot become a child; a child cannot gain children).
- A child's lane always equals its parent's lane; moving a parent to another lane moves its children too.
- Lane reorder (`PUT .../lane-order`) must list exactly the roadmap's lane IDs; positions are rewritten transactionally.
- Items carry an explicit `rank`: their position within their container (lane for top-level items, parent for children), kept **dense 0..n-1 per container** by the store on every create/move/delete. `PATCH /api/items/{id}` with `rank` means "insert at this index after removing me" (clamped; omitted rank on a container move = append). The frontend relies on rank == array index.
- Lanes have a `color` theme (blue/green/red/orange/purple — validated in the store, auto-assigned round-robin by position on create). The frontend maps the name to a hex in web/src/colors.ts and sets it as `--c` on the lane element; **all** bar/tint/border shades derive from `--c` via CSS `color-mix` in styles.css — never hard-code per-color CSS.
- Vertical layout is one row per item (top-level and children alike), stacked in rank order (web/src/layout.ts) — pixel positions are never stored, only the order is.
- Milestones have no invariants beyond non-empty title + required date; the store keeps no ordering (they're read back ordered by date). They render as diamonds in a band at the lane top (web/src/render.ts) and share the item edit panel — selection is exclusive (`state.selectItem`/`selectMilestone`/`clearSelection`). CRUD is a separate REST surface: `POST /api/lanes/{id}/milestones`, `PATCH`/`DELETE /api/milestones/{id}`.

Backend: stdlib `net/http` (Go 1.22 method routing) + pgx, hand-written SQL. internal/server is a thin JSON layer: it maps `store.ErrNotFound` → 404 and `*store.ValidationError` → 400 via `writeErr`. All item moves (dates, lane change, reparent) go through a single `PATCH /api/items/{id}`; `model.Opt[T]` distinguishes absent JSON fields from explicit `null` (used for `parentId`). Migrations: numbered SQL files in internal/store/migrations, embedded, applied at startup by store.Migrate — add a new `00N_*.sql` file, never edit applied ones. store.Migrate splits two cases: a **fresh** database (empty `schema_migrations`) is built in one step from the consolidated internal/store/schema.sql, then all existing migrations are marked applied; an **existing** database gets the pending numbered migrations. So schema.sql is the readable source of truth for the current schema — whenever you add a migration, fold the same change into schema.sql. `TestSchemaMatchesMigrations` builds both ways in a throwaway namespace and fails if they diverge.

Frontend (web/src, TypeScript, no framework, bundled by esbuild):

- `state.ts` is the single client-side source of truth (subscribe/notify); every notify triggers a **full re-render** of the chart (render.ts) with scroll preserved. There is no virtual DOM and no partial updates — keep it that way unless item counts make it slow.
- `actions.ts` wraps every mutation: optimistic local apply (mirroring the server invariants in `applyItemPatch`) → API call → rollback + toast on failure. Creates are not optimistic (server assigns IDs). New items default to a `DEFAULT_ITEM_SPAN`-day length from today; a **new child** instead starts at its parent's start and is clamped to the parent's end (`addItem`).
- `dnd.ts` is one pointer-event controller for all gestures (bar move/resize, vertical reorder, reparent, lane reorder via grip). Drop semantics: hovering a top-level item's **header `.bar`** = nest into it; anywhere else in a lane = insert as top-level at the pointer's vertical index (insertion line shown); a child over its own parent block = reorder among siblings. Drags manipulate element styles only as a preview; the model is updated once on drop through `actions.updateItem`. Drop targets are found with `elementFromPoint` while the dragged element has `pointer-events: none`.
- **Snapping** (dnd.ts) is the app's most delicate UX — treat it carefully. A dragged/resized edge magnetically snaps to nearby item edges, milestones, and today (within `SNAP_PX`), and otherwise to a user-selected calendar grid — day / week (Mon) / month (1st) / quarter — held in `state.snapMode` (persisted globally as `roadie.snap`, chosen via the magnet menu). Hold **Alt** to bypass both. Critically, snapping runs in the **boundary domain**: a bar owns pixels `[xOf(start), xOf(end+1))`, so edges snap on `start` and `end+1`, not `start`/`end` (`collectSnapBounds`, `snapBoundary`). That is what makes "A's end meets B's start" come out flush instead of overlapping by the shared inclusive day — keep any new snapping in this domain.
- `timescale.ts` converts ISO dates ↔ integer day numbers ↔ pixels; end dates are **inclusive** (a one-day item spans start==end; bar width = end − start + 1 days). `snapToGrid`/`weekStart`/`quarterStart` are the pure calendar-grid helpers (unit-tested in `timescale.test.ts`).
- Item titles that don't fit their (possibly very short) bar render **outside** it, to the right on the row background (`render.ts` `barOutside`) instead of truncating. The fit test measures the title with `canvas.measureText` (layout-free, no reflow) against the bar's pixel width. Each item owns its whole row, so that space is always free; the outside label is `pointer-events: none` (only its link re-enables clicks) so it never disturbs drag hit-testing.
- CSS-only layout tricks that are load-bearing: the chart is one scroll container with `position: sticky` for the time header (top) and lane labels (left); item bars are absolutely positioned inside `.lane-canvas`.

Verification: beyond `make test`/`make check`, UI changes should be exercised in a real browser — **by the user, by hand**. There is deliberately no browser automation here: the maintenance cost of keeping playwright scripts working against this UI outweighs what they catch. Don't add one (or reach for a headless driver ad hoc) without asking first. When a change needs eyes on it, say so and describe what to look at.
