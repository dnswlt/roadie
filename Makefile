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

.PHONY: dev build test check db-up db-down frontend frontend-watch

db-up:
	$(DC_CMD) up -d --wait db

db-down:
	$(DC_CMD) down

frontend:
	npm run --prefix web build

frontend-watch:
	npm run --prefix web watch

build: frontend
	go build -o bin/roadie ./cmd/roadie

# Run esbuild in watch mode alongside the Go server serving web/dist from disk.
dev:
	npm run --prefix web build
	npm run --prefix web watch & \
	DATABASE_URL=$(DATABASE_URL) go run ./cmd/roadie -dev -seed; \
	kill %1 2>/dev/null

test:
	DATABASE_URL=$(DATABASE_URL) go test ./...

check:
	go vet ./...
	npm run --prefix web check
