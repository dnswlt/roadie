# syntax=docker/dockerfile:1

# --- Base image definitions ---
# Keep GO_BASE in step with the go directive in go.mod.
ARG NODE_BASE=node:22-alpine
ARG GO_BASE=golang:1.25-alpine
# distroless/static is enough: the binary is built CGO_ENABLED=0 and roadie
# shells out to nothing, so the runtime needs only CA certificates (pgx talking
# TLS to Postgres) and tzdata, both of which this image already carries.
ARG RUNTIME_BASE=gcr.io/distroless/static-debian12:nonroot

# --- Stage 1: build the frontend ---
FROM ${NODE_BASE} AS webbuilder
WORKDIR /app/web

COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY web/ .
# web/dist is .dockerignore'd (it is build output), but the build script starts
# with `cp index.html favicon.svg dist/`, so the directory has to exist first.
RUN mkdir -p dist && npm run build

# --- Stage 2: build the Go binary ---
FROM ${GO_BASE} AS gobuilder
WORKDIR /src

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

# internal/store carries the embedded migrations and schema.sql; web/embed.go
# embeds dist, which must therefore be in place before the compiler runs.
COPY cmd ./cmd
COPY internal ./internal
COPY web/embed.go ./web/
COPY --from=webbuilder /app/web/dist ./web/dist

# Cache mounts keep GOCACHE and the module cache across builds.
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/roadie ./cmd/roadie

# --- Stage 3: runtime ---
FROM ${RUNTIME_BASE}

COPY --from=gobuilder /out/roadie /roadie

# 8080 is above 1024, so it binds fine as a non-root user.
EXPOSE 8080
USER 65532:65532

# -addr is in CMD, not ENTRYPOINT, so extra flags can be appended — but note
# that overriding CMD replaces it. The flag is not optional: roadie defaults to
# localhost:8080, which inside a container is reachable only from within the
# container itself.
ENTRYPOINT ["/roadie"]
CMD ["-addr=:8080"]
