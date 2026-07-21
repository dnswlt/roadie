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
- **Milestone** — a fixed point in time in a lane (a single date, title, and
  description): no duration, not ordered, not nested.

Items have an explicit order within their lane (and children within their
parent); every item gets its own row in that order. Only the order is
stored — pixel positions never are.

## Stack

- **Backend**: Go (stdlib `net/http`, pgx), JSON/REST API, serves the static
  frontend. Migrations are embedded and applied at startup.
- **Frontend**: TypeScript bundled with esbuild, no framework.
- **Storage**: PostgreSQL.

## Development

Prerequisites: Go ≥ 1.25, Node.js, Docker (Compose).

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

## Docker

The `Dockerfile` builds a small (~20 MB) distroless image with the frontend
embedded, running as non-root on `:8080`. Run the full stack locally with
Compose:

```sh
make docker-build   # build the image
make docker-up      # start db + app -> http://localhost:8080
make docker-down    # stop both
```

The app needs `DATABASE_URL` and passes `-addr=:8080` so it listens on all
interfaces inside the container.
