# Roadie

A single-page webapp for viewing and editing roadmaps, built for agile
leadership (product managers, system architects) who need an overview of
what's going on in the next couple of months and years.

## Concepts

The data model is deliberately simple; all views are derived from it.

- **Roadmap** — a top-level plan; the app supports several (e.g. one per team
  or portfolio).
- **Context** — a swimlane holding work items: projects, undertakings,
  continuous work. Reorderable via drag & drop.
- **Item** — anything that is being done, with a title, description, and a
  planned start/end date. Items can have child items (one level deep, no
  further nesting). A child always lives in its parent's lane.

Items have an explicit order within their lane (and children within their
parent); every item gets its own row in that order. Only the order is
stored — pixel positions never are.

## UI

- Drag a bar to move it in time. Drag it up/down to reorder within the lane
  (an insertion line shows where it will land), into another lane to move it
  there, or onto a top-level item's header bar to make it a child. Drop a
  child on empty lane space to detach it.
- Drag a bar's left/right edge to adjust start/end (snaps to days).
- Drag a lane's grip (⠿) to reorder swimlanes.
- Click an item to edit title, description, and dates in the side panel.
- Double-click a lane name to rename it; the color dot in the lane header
  picks one of five lane color themes (blue, green, red, orange, purple).
- Zoom with the +/− buttons or Ctrl/Cmd + scroll. The red line marks today.
- Escape cancels a drag or closes the panel.

## Stack

- **Backend**: Go (stdlib `net/http`, pgx), JSON/REST API, serves the static
  frontend. Migrations are embedded and applied at startup.
- **Frontend**: TypeScript bundled with esbuild, no framework.
- **Storage**: PostgreSQL.

## Development

Prerequisites: Go ≥ 1.22, Node.js, Docker (Compose).

```sh
make db-up      # start Postgres 17 in a container on port 5433
make dev        # esbuild watch + Go server on http://localhost:8080 (seeds a demo roadmap)
make test       # Go tests (store tests run against the compose Postgres)
make check      # go vet + tsc --noEmit
make build      # production binary with embedded frontend -> bin/roadie
```

The dev database listens on **5433** to avoid clashing with a locally
installed Postgres. Override with `DATABASE_URL` (default
`postgres://roadie:roadie@localhost:5433/roadie`).

## API

```text
GET/POST            /api/roadmaps
GET/PATCH/DELETE    /api/roadmaps/{id}         GET returns the full payload (lanes + items)
POST                /api/roadmaps/{id}/lanes
PUT                 /api/roadmaps/{id}/lane-order
PATCH/DELETE        /api/lanes/{id}
POST                /api/lanes/{id}/items
PATCH/DELETE        /api/items/{id}            PATCH handles all moves (dates, lane, parent)
```

Errors are returned as `{"error": "..."}` with appropriate status codes.
There is no authentication (v1 targets localhost / trusted networks);
concurrent edits are last-write-wins.
