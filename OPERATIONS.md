# Operations

Postgres StatefulSet + app Deployment on Kubernetes. Substitute your own object
names for `roadie-db` / `roadie`. On OpenShift, `oc` is a drop-in for `kubectl`
in every command below.

Back up the database, not the app's Export — Export omits version history,
contributors and visibility.

## Backup

```sh
kubectl exec statefulset/roadie-db -- \
  pg_dump -U roadie -Fc roadie > roadie-$(date +%F-%H%M).dump

pg_restore --list roadie-*.dump | head    # verify: errors here = truncated dump
```

## Restore

Replaces everything. Scale down first — the app migrates at startup.

```sh
kubectl scale deployment/roadie --replicas=0

kubectl exec -i statefulset/roadie-db -- \
  pg_restore -U roadie -d roadie --clean --if-exists --no-owner \
  < roadie-2026-07-31-1200.dump

kubectl scale deployment/roadie --replicas=1
```

- `-i` is required, or `pg_restore` gets an empty archive.
- Works into an empty database too (new cluster, lost PVC): the postgres image
  creates `POSTGRES_DB` on first boot, and `--if-exists` makes the DROPs no-ops.
- Older dumps are fine: `schema_migrations` is in the dump, so the app applies
  pending migrations forward on startup.
- **A dump older than 30 days loses its trash.** The sweeper purges expired
  deleted roadmaps seconds after startup (`trashTTL`, `internal/server/trash.go`).
  Restore to a scratch DB first if you need them.
- Keep `replicas=1`. The SSE hub and snapshot throttle are in-process.

## Probes

`GET /healthz` (liveness), `GET /readyz` (DB reachable). Both bypass auth.
