# CLAUDE.md

Guidance for Claude Code working in this repository.

This file holds only what the code cannot tell you: rules, settled decisions, and
environment facts. Mechanics live in comments next to the code they constrain —
those comments are good, so read the file rather than expecting a summary here.

## Commands

```sh
make deps                 # npm install for the frontend; run it after package-lock.json changes
make db-up                # start dev Postgres (container, port 5433 — see below)
make dev                  # esbuild watch + Go server (-dev -seed) on http://localhost:8080
make -C dev/oidc up       # start the throwaway OIDC provider (dev/oidc)
make dev-oidc             # like `make dev` but with -auth=oidc against that provider
make -C dev/jira run      # start the fixture-backed Jira Data Center mock
make dev-jira             # like `make dev` but with Jira Recon pointed at that mock
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
(`search.ts` + `search-list.ts` + `find.ts`) · chart projection and item filter
(`filter.ts`, held by `state.projection()`) ·
Home dialog (`home.ts`, name-path
folding in `tree.ts`) · shortcuts (`keys.ts`) ·
snapping math (`snap.ts`, driven by `dnd.ts`) · WBS view (`wbs.ts` + `wbs-dnd.ts`) ·
dependencies (`store/dependencies.go` + `depgraph.go`, `deps.ts` + `deps-graph.ts`) ·
Jira Recon view (`recon.ts`, server `tracker.go`).

## Rules

**Comments address the next reader, not the last change.** State what the code
does and the constraint behind it. Name a rejected alternative when that stops
someone reinstating it, as a standing rule rather than as history. A sentence
that only parses for someone who saw the previous version is a diary entry.

**Migrations.** Add a new numbered `internal/store/migrations/00N_*.sql`; never edit
an applied one. Then fold the same change into `internal/store/schema.sql`, which is
the readable source of truth for the current schema and the path a fresh database
takes. `TestSchemaMatchesMigrations` fails if the two diverge.

**Item invariants** (store-enforced, see internal/store): nesting is at most one
level deep; a child's lane always equals its parent's, and moving a parent moves its
children; `rank` is kept dense 0..n-1 per container, and the frontend relies on
**rank == array index**.

**Lane color.** All bar/tint/border shades derive from `--c` via CSS `color-mix`.
Never hard-code per-color CSS. Text on a lane bar is `--ink`, never `#000`.

**A warning mark on a bar is a bright fill plus a white ring** (`--flag`,
`.bar-flag`/`.bar-risk`): the fill carries the meaning, the ring the separation.
Darkening the fill to win contrast is what loses the warning — thicken the ring
instead.

**Render invalidation has exactly two scopes.** `notify()` = invalidate derived
state, drop selections that fell off screen, then fully re-render, for anything
that can change geometry or visibility. It commits a view state, so it mutates
as well as announces. `notifySelection()` = project `.selected`
onto existing DOM + re-render the panel, for pure selection changes (a rebuild
destroys the node identity click gestures need). Full is always a safe superset.
A third scope means designing a real invalidation model — ask first.

**The restore test**, for any new roadmap-scoped data: *if I restore a snapshot,
should this revert too?* Yes ⇒ it belongs in the `RoadmapExport` envelope. No ⇒ it
gets its own endpoint. Contributors, visibility and saved tracker queries are
"no"; flags, schedule and dependencies are "yes".

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
- **Find is a list, not a filter.** It never narrows the chart itself; jumping to
  a match outside the active filter clears that filter (`revealAndSelect`).
- **What is on screen is derived once, by `state.projection()`.** Hidden
  context, folded parent, active filter: any reader that rebuilds that rule by
  hand is a copy that will drift (zoom-to-fit was one, and ignored the filter).
  Renderers draw `projection.lanes`; everyone else asks `drawnItemIds`.
  Derived state has one invalidation point, `invalidateDerived`.
- **Selection is a subset of what is on screen**, pruned in `notify()`.
  Narrowing the view discards what it removed and widening never brings it
  back — no program restores a selection across a filter, and the state to do
  so is not worth carrying.
- **The item filter removes non-matches, it does not dim them**
  (`filter.ts`): at 90% dimmed, finding the survivors is scrolling — that
  shipped, and users rejected it. The one non-match kept is a parent holding a
  matching child, as its breadcrumb. Dependency-conflict membership comes from
  `analyzeDependencies` and includes both item endpoints; milestones remain
  unfiltered landmarks.
- **Item moves pause while a filter is active**; resize, lane reorder and
  selection stay live. A drop's `rank` is counted from rendered siblings
  (`indexFromY`), which only equals rank on an unfiltered render.
- **Anything that hides an entity must be undone before selecting it.** Hidden
  lane, folded parent, active filter: `revealAndSelect` clears all three, and
  `addItem` clears the filter a new item cannot match. Selecting what isn't
  rendered scrolls nowhere.
- **SSE sends a doorbell, not the data.** Diffing over the wire would reimplement
  `applyItemPatch`'s invariant logic as a second source of truth.
- **Schedule is single-track** (sprints *or* PIs, not both nested).
- **A period picker writes a plain date, and shows "—" off a boundary.** Showing
  the period a date merely falls inside makes re-picking it move that date.
- **The WBS sparkline's extent is the whole roadmap**, hidden lanes and folded
  children included: folding must never rescale the rows that stayed.
- **A dependency is one directed edge with no attributes** — no types, lag, or
  labels (the user-colored-star argument again). Stored prerequisite → dependent;
  roadmap-scoped only; a DAG, enforced in the store with rejections that name the
  conflicting chain. Nesting implies no edges.
- **Dependencies are never drawn on the timeline.** The chart projects time;
  edges across it are the spaghetti this feature avoids. The local one-hop
  overlay (`deps.ts`, recenter by clicking) is the only graph projection.
- **Tentative and at-risk are booleans, not workflow status** — no confidence
  percentages, no off-track/blocked/done; both coexist with the flag. Tentative
  is a sawtooth silhouette (`.bar-shape`), never opacity, which means hierarchy.
- **Color is chosen by user preference; only the lane label carries identity.** So the palette is judged
  by eye and by what a hex must sit next to — not against a CVD distance threshold.
  Raise contrast/CVD only when something concrete breaks (text going illegible, a
  warning marker lost in a lane bar), not as a gate on every color change. The one
  hard number, from exactly such a break: **a lane fill clears 7.0 against `--ink`**
  (colors.ts). Separation and CVD stay by eye.
- **`--danger` is chrome-only** — menus, dialogs, buttons, toasts, the rail. It
  means "destructive, or already failed", so red never renders on the timeline;
  chart warnings are `--flag`, including dependency conflicts.
- **Roadmap names stay flat; Home folds `>` into a tree** (`tree.ts`) — a rendered
  convention, nothing stored, no round-trip. A row sits at its path minus its own
  last segment, so `Platform` stays top level beside a `Platform` folder. Folders
  are synthetic and never selectable, and start shut except on the path to the
  selection.
- **One popover at a time, owned by `popover.ts`.** Every dropdown registers on
  open and gets a handle; owners close through the handle, never by hiding the
  element themselves. **Openers must not `stopPropagation`** — dismissal runs in
  the capture phase, so swallowing protects nothing and blinds every other
  surface (that was the bug).
- **No read-only sharing.** Public means writable; visibility is not a permission
  system.
- **Version history is "go back", not undo.**
- **A checkpoint is a snapshot with a name**: the name is what promotes it to
  `kind = manual` and exempts it from pruning. No separate table, flag or concept.
- **E2E is a smoke layer, not a UI test suite** (`web/e2e`, `make test-e2e`).
  Playwright exists only for what a real browser answers and nothing else can —
  pointer gestures, panel flows whose bug *is* the focus behaviour, and popover
  exclusivity (event phase across surfaces) — and every
  test follows one pattern: **seed via API, act in the browser, assert via API,
  purge**. The UI is the actuator, the model is the oracle: no screenshots, and
  the only selectors are the class contracts the controllers themselves hit-test.
  A DOM assertion needs client-only state the server cannot be asked about (a
  `.selected` class, which period a dropdown displays) and a note in the spec
  saying so. Tests run against the open-auth server on their own port and
  create/purge their own roadmaps, so a live dev DB is safe.

Deliberate exceptions and scope limits, so they don't read as bugs:

- Roadmap DELETE is the **only mutation not wrapped in `s.snap`**: `snapshots` cascade
  on delete, so a pre-delete snapshot would destroy itself. Soft delete covers it.
- The SSE hub and the snapshot throttle are in-process ⇒ **single-replica**. The clean
  upgrade is Postgres LISTEN/NOTIFY into the same hub.
- The roadmap **list** is not live — only the open roadmap's contents.
- **Import always creates a public roadmap** (the owner is recorded, so it can be
  flipped straight after).

## Ask first

A third render scope · multi-track schedule · e2e tests outside the seed/act/
assert-via-API pattern (screenshots, DOM assertions beyond client-only state,
anything a DOM-free module could have pinned) · a second flag ·
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
