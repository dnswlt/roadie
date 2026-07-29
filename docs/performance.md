# Write-path performance

Measured 2026-07-29, on the `feature/private-public` branch, when adding the
visibility/authorization check raised the question of whether per-request checks
were accumulating into something the user would feel.

Short answer: no. A burst gesture is bound by the roadmap row lock, not by
per-request checks or by the transport. Numbers below.

## What was measured

The worry case is a **burst gesture**: dragging a parent moves its children too,
and a multi-select shift moves everything selected. Both fan out to one `PATCH
/api/items/{id}` per item, issued in parallel (`Promise.all` in
`actions.moveItemWithChildren` / `shiftItems`).

Two things that look like bursts but aren't: reordering an item is a **single**
PATCH (the store renumbers siblings inside its own transaction — the client
never sends per-sibling rank updates), and the SSE broadcasts a burst triggers
are collapsed by the receiver's ~250 ms debounce into one refetch.

## Results

Medians, over a jittery WiFi link (p95 ≈ 1.5× p50).

| | all local | DB on nuc, server local | server + DB on nuc |
|---|---|---|---|
| network baseline (`/healthz`) | — | — | 5 ms |
| single PATCH | 4 ms | 47 ms | **13 ms** |
| burst of 11 (parent + children) | 31 ms | 439 ms | **82 ms** |
| burst of 30 (multi-select) | 60 ms | 745 ms | **158 ms** |

The third column is the realistic one: app server next to its database, client
across the network. The second column is an app server *far* from its database
— a deployment mistake rather than a target — and is kept only because it makes
the scaling behaviour obvious.

**These are confirmation latencies, not perceived latencies.** Every one of
these gestures is applied optimistically and re-rendered before the request goes
out, so nobody waits on these numbers. What they bound is how long another
browser stays stale, and how late a rollback would arrive if a write failed.

## Where the time goes

A date-only PATCH is about **8 round trips** to Postgres: resolve the roadmap
id, check access, then `Begin` → lane lookup → `SELECT … FOR UPDATE` → read item
→ `UPDATE` → `Commit`. Five of those sit *inside* the transaction, so
`lockRoadmap` is held for their whole duration, and concurrent PATCHes to the
same roadmap serialize behind it.

Probing that directly (12 parallel PATCHes to one roadmap vs. the same 12 spread
over 12 roadmaps, so there is no shared lock):

| | contended | uncontended |
|---|---|---|
| local DB | 26 ms | 12 ms |
| DB on nuc | 346 ms | 105 ms |

So lock wait is ~50% of a burst locally and ~70% with a remote database. The
cost of the lock is (round trips inside the transaction) × RTT, which is why it
is nearly invisible locally and dominant when the database is far away — or,
by the same mechanism, when it is merely loaded.

## Three findings worth not rediscovering

**Authorization is not the cost.** An A/B against a build with `s.guard`'s check
stubbed out (verified genuinely different: the real build 404s an outsider on a
private roadmap, the stub serves 200) showed no difference beyond noise locally,
and ~4 ms — exactly one round trip — with a remote database. It stays cheap in
bursts (2–6%) because `guard` runs *outside* the transaction, so N checks
overlap instead of stacking. The query itself is <0.1 ms.

Note the measurement gap: the benchmark ran in open mode against public
roadmaps, where `visibility = 'public' OR EXISTS (…)` short-circuits and never
touches `roadmap_members` (`EXPLAIN` confirms `never executed`). The private
branch was measured separately at the SQL level, not end to end.

**HTTP/2 would buy nothing.** Capping the client at 6 connections per origin
(what a browser allows over HTTP/1.1) and leaving it unlimited give the same
result — 82/82 ms and 158/168 ms. The requests serialize on the lock regardless
of how many sockets they arrive on, so multiplexing has nothing to win.

**The rule for new per-request work:** outside the roadmap lock it is nearly
free and parallelizes; inside it costs N× per burst. The trash and visibility
checks are both outside it. Keep new ones there.

## If it ever needs optimizing

Batching a burst into one request, sized against the 158 ms figure:

- one request, one transaction, looping internally: **~70 ms** — the lock is
  acquired once and the resolve/auth overhead paid once, but two round trips per
  item remain;
- plus set-based SQL (one multi-row `UPDATE`, one renumber): **~15 ms**.

The win comes from the SQL inside the endpoint, not from merging the HTTP
requests. It is a 2–10× on something already imperceptible, so it stayed
deferred.

## Caveats

Single client throughout. Two people dragging in the *same* roadmap contend for
the same lock and their bursts serialize against each other — that is the case
where 158 ms could become noticeable, and it is untested. The client was Node,
not a browser, with a semaphore standing in for the browser's connection limit;
it models queueing, not connection setup. Open mode means `recordContributor`
early-returns, so an OIDC deployment adds one upsert per mutation (outside the
lock, so it parallelizes) that these numbers do not include.

## Reproducing

Point a server at a database, then drive `/api` from a client: create a
throwaway roadmap, a lane, a parent with 10 children and 30 top-level items;
warm up with one PATCH so the first auto-snapshot is not inside a timed run
(it costs an extra ~12–17 ms, once per roadmap per `snapshotInterval`); then
time `Promise.all` over one date-only PATCH per item. Purge the roadmap
afterwards. For the lock probe, compare N parallel PATCHes to one roadmap
against N spread over N roadmaps.
