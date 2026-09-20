# Railway deployment plan

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Pilot topology

Use separate gateway, runner and relay service roles, which may share one application image with different entrypoints once implemented. Initially use two explicitly addressable runner services rather than assuming arbitrary replicas behind one service hostname can serve as unique Cluster endpoints.

PlanetScale supplies control PostgreSQL; Turso supplies actor databases; the customer's sink is external. Local development uses separate fixtures. A Railway private service DNS endpoint must be tested for the exact routing/IPv6/replica behavior required by the chosen Effect transport.

## Health and readiness

Liveness verifies process/event loop health. Readiness verifies the service can safely serve its assigned role: registry loaded, compatible schema, reachable required stores and correct runner registration. A health route is not an actor. Do not return ready merely because a port is open while migrations/ownership recovery are incomplete.

## Shutdown

SIGTERM stops new acceptance/assignment, drains or aborts local transactions, ensures durable delivery tracking remains, releases resources and exits before the platform timeout. Hard kill still works through receipts/fencing. Graceful finalizers improve availability, not correctness.

## Connections

Bound direct PostgreSQL sessions for runner ownership. Configure ordinary query pools separately. Include actor DB clients and external provider concurrency in total process resource limits. Do not create a large SQL pool per actor.

## Rolling versions

Deploy compatible code with database expand/contract discipline. Track actor protocol and schema ranges. Keep workflows/completion routes compatible or version-routed. Revert deployment only when the old code can read the current schema; a rollback button does not undo a migration.

## Config templates

The archive's Railway files establish build/start role boundaries but do not deploy a working service. Entry scripts intentionally refuse runtime execution until implementations and readiness endpoints exist. Real private addresses, project IDs and secrets are supplied during deployment setup, never hard-coded in the scaffold.

## Sources and evidence

- [D01: Railway monorepos](https://docs.railway.com/guides/monorepo) — Service build/start boundaries and watch paths.
- [D02: Railway private networking](https://docs.railway.com/guides/private-networking) — Must validate per-replica identity/routing, not use one load-balanced address as runner identity.
- [D03: Railway configuration](https://docs.railway.com/reference/config-as-code) — Config schema for deployment scaffold.
- [P01: PlanetScale PostgreSQL pooling](https://planetscale.com/docs/postgres/connecting/pgbouncer) — Transaction pool on port 6432; session-sensitive locks require suitable direct/session connection.
- [E03: SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts) — Reserved/rebuildable PostgreSQL connection and advisory lock behavior; assess current hardening, not an old issue headline.
