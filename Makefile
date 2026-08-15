# Port 5433: the machine may run its own Postgres on 5432.
DATABASE_URL ?= postgres://roadie:roadie@localhost:5433/roadie
DOCS_PYTHON ?= .venv/bin/python

UNAME_S := $(shell uname -s)
# macOS (Homebrew/Colima): Uses the dashed binary (even in newer versions like 5.0.x)
ifeq ($(UNAME_S),Darwin)
    DC_CMD := docker-compose
# Linux: Use compose via Docker Plugin (the "modern" way)
else
    DC_CMD := docker compose
endif

# Which provider `make dev-oidc` authenticates against. The defaults match the
# throwaway one in dev/oidc (start it with `make -C dev/oidc up`); override them
# to point at any other provider.
OIDC_ISSUER ?= http://localhost:4011
OIDC_CLIENT_ID ?= roadie-dev
OIDC_CLIENT_SECRET ?= roadie-dev-secret
# Roadie's own listen address — the same one `make dev` uses.
OIDC_ADDR ?= localhost:8080
JIRA_URL ?= http://localhost:4012

.PHONY: dev dev-oidc dev-jira deps kill-watch build test check db-up db-down frontend frontend-watch \
	docker-build docker-up docker-down docs docs-serve

db-up:
	$(DC_CMD) up -d --wait db

db-down:
	$(DC_CMD) down

# Build the app image (multi-stage; embeds the frontend) via compose.
docker-build:
	$(DC_CMD) build app

# Build if needed, then run the whole stack — db + app — in the background.
# The app reaches Postgres as db:5432 on compose's network and waits for its
# healthcheck; it is published on http://localhost:8080.
docker-up:
	$(DC_CMD) --profile app up -d --build --wait

# Stop and remove the stack (both services, including the profiled app). The
# db volume is kept.
docker-down:
	$(DC_CMD) --profile app down

# Frontend dependencies, like the docs ones below: never installed implicitly.
# Run this after pulling a commit that changes package-lock.json.
deps:
	npm install --prefix web

frontend:
	npm run --prefix web build

frontend-watch:
	npm run --prefix web watch

build: frontend
	go build -o bin/roadie ./cmd/roadie

# Run esbuild in watch mode alongside the Go server serving web/dist from disk.
# `trap 'kill 0' EXIT` is the standard idiom: on exit it kills the whole process
# group, so Ctrl-C reaps the esbuild watcher too (even with npm/sh in between,
# which a plain `kill %1` would leave orphaned — the bug this fixes on WSL).
dev:
	npm run --prefix web build
	@trap 'kill 0' EXIT; \
	npm run --prefix web watch & \
	DATABASE_URL=$(DATABASE_URL) go run ./cmd/roadie -dev -seed

# Run Roadie against the throwaway Jira Data Center server in dev/jira. Start
# that server separately with `make -C dev/jira run`.
dev-jira:
	@curl -s --max-time 3 -o /dev/null $(JIRA_URL)/healthz \
		|| { echo "no Jira mock at $(JIRA_URL) — run 'make -C dev/jira run'"; exit 1; }
	JIRA_URL=$(JIRA_URL) $(MAKE) dev

# Like `dev`, but with authentication on. Serves on the same address as `make
# dev`, so bookmarks and per-origin localStorage carry over.
#
# This runs Roadie only; the provider has to be up already
# (`make -C dev/oidc up`).
#
# SESSION_KEY is deliberately not set: roadie then generates a random one per
# run, so no secret is baked into the repo. The only cost is being logged out
# on restart. Export SESSION_KEY yourself to keep a session across restarts.
dev-oidc:
	@curl -s --max-time 3 -o /dev/null $(OIDC_ISSUER)/.well-known/openid-configuration \
		|| { echo "no OIDC provider at $(OIDC_ISSUER) — run 'make -C dev/oidc up'"; exit 1; }
	npm run --prefix web build
	@trap 'kill 0' EXIT; \
	npm run --prefix web watch & \
	DATABASE_URL=$(DATABASE_URL) \
	OIDC_ISSUER=$(OIDC_ISSUER) \
	OIDC_CLIENT_ID=$(OIDC_CLIENT_ID) \
	OIDC_CLIENT_SECRET=$(OIDC_CLIENT_SECRET) \
	go run ./cmd/roadie -dev -seed -addr=$(OIDC_ADDR) -auth=oidc \
		-oidc-redirect-url=http://$(OIDC_ADDR)/auth/callback

# Fallback: kill stray esbuild watchers left over from an interrupted `make dev`.
kill-watch:
	@pkill -f 'esbuild.*--watch' && echo "killed stray esbuild watcher(s)" || echo "no esbuild watchers running"

test:
	DATABASE_URL=$(DATABASE_URL) go test ./...
	npm run --prefix web test

# Browser gesture tests (web/e2e, Playwright) — deliberately not part of
# `test`: they need the dev DB up and a browser installed
# (`npx --prefix web playwright install chromium`, once). They reuse a running
# `make dev` server, or start their own against the dev DB.
test-e2e:
	npm run --prefix web e2e

check:
	go vet ./...
	npm run --prefix web check

# Documentation dependencies are deliberately not installed implicitly. Set up
# a virtual environment and install requirements-docs.txt once, then use these
# targets to build or preview the site.
docs:
	NO_MKDOCS_2_WARNING=1 $(DOCS_PYTHON) -m mkdocs build --strict

docs-serve:
	NO_MKDOCS_2_WARNING=1 $(DOCS_PYTHON) -m mkdocs serve
