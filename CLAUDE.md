# CLAUDE.md

Guidance for Claude Code working in this repository.

This file holds only what the code cannot tell you: rules, settled decisions, and
environment facts. Mechanics live in comments next to the code they constrain —
those comments are good, so read the file rather than expecting a summary here.

## Commands

```sh
make db-up                # start dev Postgres (container, port 5433 — see below)
make dev                  # esbuild watch + Go server (-dev -seed) on http://localhost:8080
make -C dev/oidc up       # start the throwaway OIDC provider (dev/oidc)
make dev-oidc             # like `make dev` but with -auth=oidc against that provider
make test                 # Go tests (store tests skip if DATABASE_URL unset) + frontend tests
make test-e2e             # browser gesture tests (web/e2e); needs db-up + `npx --prefix web playwright install chromium` once
make check                # go vet + tsc --noEmit
make build                # production binary (embedded frontend) -> bin/roadie
npm run --prefix web build   # frontend only (web/build.mjs: hashed assets + index.html)
npm run --prefix web test    # frontend unit tests only
```

Single Go test: `DATABASE_URL=postgres://roadie:roadie@localhost:5433/roadie go test ./internal/store -run TestItemInvariants`

## Environment (this machine)

- The dev DB is on **port 5433** — a native Postgres owns 5432. Don't "fix" it back.
- Docker runs via colima; the Makefile deliberately uses the dashed `docker-compose`
  binary on macOS (`DC_CMD`). The `docker compose` plugin is not wired up here.
- `make dev` serves `web/dist` from disk (`-dev`); production embeds it via `go:embed`
  (web/embed.go). `web/dist/.gitkeep` must exist or the embed won't compile.

## Architecture

Single-page roadmap editor. Guiding principle: **radically simple data model; all
views are derived from it.**

Model: `roadmaps` → `lanes` ("contexts", the swimlanes) → `items` (inclusive
start/end dates, nullable `parent_id`, explicit `rank`). Lanes also hold
`milestones` (a single date, no duration, no rank, not nested). Roadmaps hold
`schedule_periods` (sprints/PIs) — roadmap-scoped, unlike everything else — and
`dependencies` (directed item/milestone edges, also roadmap-scoped).

Backend: stdlib `net/http` (Go 1.22 method routing) + pgx, hand-written SQL.
internal/server is a thin JSON layer (`store.ErrNotFound` → 404,
`*store.ValidationError` → 400 via `writeErr`). **Invariants are enforced in
internal/store** — not in triggers, not in handlers.

Frontend: web/src, TypeScript, no framework, esbuild. `state.ts` is the single
client-side source of truth (subscribe/notify); there is no virtual DOM and no
diffing. `actions.ts` wraps every mutation (optimistic apply → API → rollback +
toast). `dnd.ts` is one pointer-event controller for all timeline gestures;
`wbs-dnd.ts` is its WBS twin (vertical only), each blind to the other view's DOM.

Where things live: snapshots (store/server/`history.ts`) · trash
(`trash.go`) · visibility (`store/access.go`, `s.guard`) · contributors
(`contributors.go`) · schedule (`schedule.go`, `schedule.ts`) · SSE
(`server/events.go`, `events.ts`) · auth (`internal/auth`) · find
(`search.ts` + `search-list.ts` + `find.ts`) · Home dialog (`home.ts`) · shortcuts (`keys.ts`) ·
snapping math (`snap.ts`, driven by `dnd.ts`) · WBS view (`wbs.ts` + `wbs-dnd.ts`) ·
dependencies (`store/dependencies.go` + `depgraph.go`, `deps.ts` + `deps-graph.ts`).

## Rules

**Migrations.** Add a new numbered `internal/store/migrations/00N_*.sql`; never edit
an applied one. Then fold the same change into `internal/store/schema.sql`, which is
the readable source of truth for the current schema and the path a fresh database
takes. `TestSchemaMatchesMigrations` fails if the two diverge.

**Item invariants** (store-enforced, see internal/store): nesting is at most one
level deep; a child's lane always equals its parent's, and moving a parent moves its
children; `rank` is kept dense 0..n-1 per container, and the frontend relies on
**rank == array index**.

**Lane color.** All bar/tint/border shades derive from `--c` via CSS `color-mix`.
Never hard-code per-color CSS.

**Render invalidation has exactly two scopes.** `notify()` = full chart re-render,
for anything that can change geometry. `notifySelection()` = project `.selected`
onto existing DOM + re-render the panel, for pure selection changes (a rebuild
destroys the node identity click gestures need). Full is always a safe superset.
A third scope means designing a real invalidation model — ask first.

**The restore test**, for any new roadmap-scoped data: *if I restore a snapshot,
should this revert too?* Yes ⇒ it belongs in the `RoadmapExport` envelope. No ⇒ it
gets its own endpoint. Contributors and visibility are "no"; flags, schedule and
dependencies are "yes".

**Mutating routes go through the `s.snap` wrapper**, which does three jobs at once:
pre-mutation snapshot, SSE broadcast, contributor attribution, plus `s.guard` for
access. Adding a mutating route outside it silently loses all four. The one
deliberate exception is roadmap DELETE — see below.

**Snapping (snap.ts, driven by dnd.ts) is the most delicate UX here.** It runs in
the boundary domain (a bar owns `[start, end+1)`). Keep new snapping in that
domain, and in snap.ts — DOM-free so snap.test.ts can pin what hand-testing
misses. **Every decision is "nearest target from a fixed set"**, never "try A,
else B": that is what makes a drag monotonic. Both snapping bugs so far were the
second shape.

**Auth off is the default and must keep working** — no login, everyone edits, plain
`curl` against the API. `auth.From(ctx)` always returns an `Identity` (anonymous
when auth is off), so **no handler branches on the auth mode**; only `server.New`
knows. Secrets come from the env, never flags (flags are visible in `ps`).

## Settled — don't re-litigate

- **No second flag, and no flag color.** Two markers whose meaning the user assigns
  at mark time is the rejected user-colored-star design again: nothing records what
  they meant. One flag, one glyph, meaning owned by the product.
- **The flag is not a reserved label.** A magic string in free-form text is a
  convention, not an invariant, and toggling would be a read-modify-write that loses
  concurrent label edits under SSE.
- **A move grid-snaps its start edge only.** Both edges competing made the winner
  flip mid-drag and the bar jump half a grid period. Features still align either
  edge, so a bar can still close flush against a neighbour.
- **The edit rail is a fixture, not a popup.** It holds its width whatever is
  selected, so the chart never resizes mid-task. Selecting never reopens a
  collapsed rail; only an explicit edit does (`focusPanelTitle`).
- **Assets are content-hashed, and nothing else is cached.** `/assets/*` is
  `immutable`, everything else `no-store` (`cacheHeaders`, server.go).
- **Find is a list, not a filter.** Dimming the chart to matches (a third `Focus`
  variant) was considered and dropped.
- **SSE sends a doorbell, not the data.** Diffing over the wire would reimplement
  `applyItemPatch`'s invariant logic as a second source of truth.
- **Schedule is single-track** (sprints *or* PIs, not both nested).
- **A dependency is one directed edge with no attributes** — no types, lag, or
  labels (the user-colored-star argument again). Stored prerequisite → dependent;
  roadmap-scoped only; a DAG, enforced in the store with rejections that name the
  conflicting chain. Nesting implies no edges.
- **Dependencies are never drawn on the timeline.** The chart projects time;
  edges across it are the spaghetti this feature avoids. The local one-hop
  overlay (`deps.ts`, recenter by clicking) is the only graph projection.
- **Color is chosen by user preference; only the lane label carries identity.** So the palette is judged
  by eye and by what a hex must sit next to — not against a CVD distance threshold.
  Raise contrast/CVD only when something concrete breaks (text going illegible, a
  warning marker lost in a lane bar), not as a gate on every color change.
- **No read-only sharing.** Public means writable; visibility is not a permission
  system.
- **Version history is "go back", not undo.**
- **E2E is a gesture smoke layer, not a UI test suite** (`web/e2e`, `make test-e2e`).
  Playwright exists only for what needs a real layout engine — pointer gestures —
  and every test follows one pattern: **seed via API, act via pointer, assert via
  API, purge**. The UI is the actuator, the model is the oracle: no DOM-content
  assertions, no screenshots, and the only selectors are the class contracts the
  controllers themselves hit-test. Tests run against the open-auth server on their
  own port and create/purge their own roadmaps, so a live dev DB is safe.

Deliberate exceptions and scope limits, so they don't read as bugs:

- Roadmap DELETE is the **only mutation not wrapped in `s.snap`**: `snapshots` cascade
  on delete, so a pre-delete snapshot would destroy itself. Soft delete covers it.
- The SSE hub and the snapshot throttle are in-process ⇒ **single-replica**. The clean
  upgrade is Postgres LISTEN/NOTIFY into the same hub.
- The roadmap **list** is not live — only the open roadmap's contents.
- **Import always creates a public roadmap** (the owner is recorded, so it can be
  flipped straight after).

## Ask first

A third render scope · multi-track schedule · e2e tests outside the gesture
pattern (DOM-content assertions, screenshots, non-gesture flows) · a second flag ·
changing what `-auth=off` does · dependency edge attributes or kinds · drawing
dependencies on the timeline.

## Verification

Beyond `make test` / `make check`, UI changes must be exercised in a real browser
**by the user, by hand** — there is no DOM test runner here. Test pure logic by
extracting it into a DOM-free module (`links.ts` ← `links.test.ts`, `search.ts`,
`timescale.ts`, `schedule.ts`, `snap.ts`); frontend tests are `node:test` files
next to their source, transpiled into `web/test-out/`. Pointer gestures — the one
thing neither route covers — are pinned by the e2e smoke layer (`web/e2e`; see the
settled pattern below). When a change needs eyes on it, say so and describe what
to look at.
