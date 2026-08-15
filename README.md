# Roadie

Roadie is a focused roadmap editor for people planning large software and
systems projects. It helps communicate significant outcomes, when they are
expected, how they decompose, and what depends on what—without becoming another
task tracker.

Roadmaps can be organized into contexts, parent and child items, and milestones.
Roadie provides timeline and Work Breakdown Structure views, user-defined
planning schedules, dependencies, priorities, labels, version history, and
collaboration.

See the [user guide](https://dnswlt.github.io/roadie/) for an introduction to
Roadie's concepts and features.

## Stack

- **Backend**: Go (stdlib `net/http`, pgx), JSON/REST API, serves the static
  frontend. Migrations are embedded and applied at startup.
- **Frontend**: TypeScript bundled with esbuild, no framework.
- **Storage**: PostgreSQL.

## Development

Prerequisites: Go ≥ 1.25, Node.js, Docker (Compose).

```sh
make deps       # npm install for the frontend; run it after package-lock.json changes
make db-up      # start Postgres 17 in a container on port 5433
make dev        # esbuild watch + Go server on http://localhost:8080 (seeds a demo roadmap)
make test       # Go tests (store tests run against the compose Postgres)
make check      # go vet + tsc --noEmit
make build      # production binary with embedded frontend -> bin/roadie
```

The dev database listens on **5433** to avoid clashing with a locally
installed Postgres. Override with `DATABASE_URL` (default
`postgres://roadie:roadie@localhost:5433/roadie`).

## Documentation

The user guide is published at <https://dnswlt.github.io/roadie/>. Its Markdown
source lives in [`docs`](docs) and is built with MkDocs Material.

To preview it locally, install the pinned documentation dependency in a virtual
environment and start the development server:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-docs.txt
make docs-serve
```

`make docs` performs the same strict production build used by CI.

## Authentication

By default Roadie runs **open**: no login, everyone can see and edit everything,
and the JSON API answers a plain `curl`. On a trusted network that is the whole
setup — there is nothing to configure, and every roadmap is public, since a
private one would need an owner to belong to.

Passing `-auth=oidc` instead delegates login to an OIDC provider (Entra ID, say).
Roadie keeps no password store, no user table and no session table: the
authorization code flow runs server-side, the ID token is used once to learn who
the user is, and the browser gets only an encrypted session cookie.

```sh
export OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
export OIDC_CLIENT_ID=<application-id>
export OIDC_CLIENT_SECRET=<client-secret>
export SESSION_KEY=$(openssl rand -base64 32)   # 32 bytes; share it across replicas

roadie -auth=oidc -oidc-redirect-url=https://roadie.example.com/auth/callback
```

Register the app in Entra as a **Web** platform client (not SPA — Roadie is a
confidential client) with that exact redirect URI. Pin `OIDC_ISSUER` to your
tenant rather than the `common` endpoint: issuer validation then restricts
logins to it, with nothing extra to configure.

The callback is served at whatever path `-oidc-redirect-url` names, so Roadie can
fit a registration whose redirect URI you do not control.

`SESSION_KEY` seals the session cookie. If unset, a random one is generated at
startup, which logs everyone out on restart and cannot work across replicas.
`-session-ttl` (default 12h) sets how long a login lasts.

For local development, [dev/oidc](dev/oidc) has a throwaway identity provider:

```sh
make -C dev/oidc up      # start the provider
make dev-oidc            # `make dev` with authentication on, against it
make -C dev/oidc down    # stop the provider
```

`make dev-oidc` defaults to that provider; override `OIDC_ISSUER`,
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` or `OIDC_ADDR` to point it elsewhere.

Point it at a provider's **plain-HTTP** endpoint locally. A self-signed HTTPS
provider makes the browser refuse the login redirect, and `-oidc-insecure-tls`
cannot fix that: the flag only relaxes Roadie's own client (discovery, token
exchange), while the browser connects to the provider itself and applies its own
trust store. That flag is therefore only useful for a headless/scripted flow,
and never in production.

## Jira reconciliation

Set `JIRA_URL` and `JIRA_TOKEN` to enable the read-only Jira Data Center client.
The token has no flag equivalent.

For local development:

```sh
make -C dev/jira run
make dev-jira
```

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

## Operations

[OPERATIONS.md](OPERATIONS.md) — database backup and restore, probes.
