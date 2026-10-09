# ADR 0117: Pooler-safe Postgres locking

**Status:** proposed (2026-10-09), for #712. No pooler implementation or support claim is made here.

## Context

Small customer databases need fewer sessions per runner. The supported `Database.postgres({ preset: "low-connection" })` baseline uses four primary sessions: one turn, two off-turn, one query. This changes pool defaults only, not durable authority. Explicit sizes override the preset; replica and coordination pools remain additional.

Effect 4.0.2's [`SqlRunnerStorage`](https://github.com/Effect-TS/effect/blob/effect%404.0.2/packages/effect/src/cluster/SqlRunnerStorage.ts) reserves one off-turn connection for its lifetime **even with table leases**. It then creates tables and handles registration through the ordinary client, so at least one other session must remain available. The reservation is included in the off-turn maximum, not an extra fifth session. Four is the minimum with the current separate turn/query pools, not a throughput recommendation. Three would require changing pool ownership or the upstream reservation contract.

This reservation is also a correctness boundary in advisory mode: a lock belongs to a server backend, not a logical client connection. [PgBouncer's feature matrix](https://www.pgbouncer.org/features.html) explicitly excludes session advisory locks and `LISTEN` from transaction pooling. After COMMIT, a client can receive another backend; closing its client socket does not necessarily release an advisory lock left on the old backend. Reserving a driver connection does not pin that backend through a transaction pooler.

Current session-dependent paths include:

- Cluster advisory locks for embedded Postgres; public `Runner.socket` already uses table leases, but the pinned storage still reserves a connection in that mode.
- `withMigrationCoordination`: a session advisory lock covers history-table creation and subsequent transactional migrations on its reserved connection.
- Fleet maintenance: a reserved session owns its advisory lock and logical slot operations. With separate coordination, it also reserves a data session.
- The public `PgClient.listen` surface, application reservations/session state, and driver's prepared-statement cache. Turn tenant settings are transaction-local, but role/reset, cancellation and pipelined transaction behavior must also be verified through a pooler.

## Proposed direction

Support transaction pooling for **stateless transaction-bound pools only**, with explicit direct/session-pooled endpoints for paths that still require server-session identity. Do not silently infer pooler mode from a URL, turn advisory locks off, or replace ownership with a process-local mutex.

Before implementation:

1. Give Cluster table-lease storage a statement/transaction-owned acquisition path, preferably upstream, without the lifetime reservation. Keep registrations, refresh, acquired-shard readiness and singleton lease checks on the same authority. Preserve durable generation fencing: lease expiry alone cannot authorize stale writes. Advisory-mode Cluster stays on a direct/session endpoint unless its ownership design changes separately.
2. Replace the startup session mutex only after proving a transaction-owned lock can serialize **history creation and the complete migration transaction** on one backend. A transaction advisory lock acquired after uncoordinated `CREATE TABLE IF NOT EXISTS` is too late. Keep a direct startup endpoint as the initial alternative; do not release coordination between DDL phases or edit applied migrations.
3. Keep the fleet lock/slot reader on a direct/session endpoint initially. Moving it requires a fenced ownership token for both derived writes and slot advancement, with stale-owner and lost-acknowledgment recovery; a timed lease alone weakens the current exclusion. Budget its additional sessions explicitly.
4. Retain transaction-owned coordination rows and authority-before-data local fences from [ADR 0066](0066-authoritative-coordination.md). A separate endpoint is not distributed atomic commit. Probe authority loss, roll back guarded work, and resolve ambiguous commits from durable rows.
5. Audit the pinned wire driver: PgBouncer protocol-level prepared statements require nonzero `max_prepared_statements`; SQL `PREPARE` is not equivalent. Verify name reuse, pipelined BEGIN/COMMIT/ROLLBACK, savepoints, transaction-local role/tenant settings, server keepalive startup parameters, cancellation routing and backend replacement. Do not rely on connection-local settings outside a transaction. `LISTEN`, temporary session tables and arbitrary app reservations stay outside the stateless support envelope.

## Required evidence before acceptance

Run against a pinned **real PgBouncer in transaction mode** and Postgres 18.6, with fewer server backends than logical clients. Force backend reassignment between every transaction, saturate backend capacity, and separately count both client sockets and Postgres sessions.

- Concurrent empty-database startup, interrupted migration rollback, restart and compatibility refusal.
- Single/multi-runner shard acquisition, expiry, singleton failover, stale-generation rejection, clean drain and SIGKILL.
- Held turns plus job claims/renewals, relay receiver replay, workflow actor calls/sleep/interruption/restart and inspector snapshots; no session or backend checkout may stay held while waiting on work that needs that same capacity.
- Terminate and blackhole both the pooler and individual backends while ownership is held; prove locks release or ownership fails closed before another writer is admitted. Recover unknown COMMIT outcomes under original command ids.
- Prepared statements, savepoints, rollback-after-abort, tenant/RLS isolation, interrupted/cancelled queries and released waiters after backend reassignment.
- If fleet is routed through the pooler, stale-maintainer writes/slot advancement and takeover after loss must be fenced, not merely observed.

Passing direct-Postgres low-connection tests does not satisfy these gates. Session pooling is also unverified until tested; statement pooling cannot run Akter's multi-statement transactions.

## Alternatives and limits

Increasing Postgres `max_connections` costs server memory and does not remove session dependencies. Sharing every pool would reduce sockets but couples a waiting background claim to the turn that must finish it, and readers to admission; the four-session preset retains those ownership boundaries. A separate direct coordination endpoint is a useful staged design but does not, on its own, make migrations, fleet, application SQL or cancellation pooler-safe.

The current baseline's wait-cycle analysis and direct-Postgres evidence are recorded in [low-connection verification](../verification/low-connection-postgres.md). Pooler-safe implementation belongs in a separate change and this ADR remains proposed.
