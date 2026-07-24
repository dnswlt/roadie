# Port 5433: the machine may run its own Postgres on 5432.
DATABASE_URL ?= postgres://roadie:roadie@localhost:5433/roadie

UNAME_S := $(shell uname -s)
# macOS (Homebrew/Colima): Uses the dashed binary (even in newer versions like 5.0.x)
ifeq ($(UNAME_S),Darwin)
    DC_CMD := docker-compose
# Linux: Use compose via Docker Plugin (the "modern" way)
else
    DC_CMD := docker compose
endif

.PHONY: dev kill-watch build test check db-up db-down frontend frontend-watch \
	docker-build docker-up docker-down

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

# Fallback: kill stray esbuild watchers left over from an interrupted `make dev`.
kill-watch:
	@pkill -f 'esbuild.*--watch' && echo "killed stray esbuild watcher(s)" || echo "no esbuild watchers running"

test:
	DATABASE_URL=$(DATABASE_URL) go test ./...
	npm run --prefix web test

check:
	go vet ./...
	npm run --prefix web check
