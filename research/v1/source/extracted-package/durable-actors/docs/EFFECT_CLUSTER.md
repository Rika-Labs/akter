# Effect Cluster integration

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Reuse, do not rebuild

The inspected Cluster Entity example already provides typed RPC clients, entity type/id addressing, sequential default handlers, maxIdleTime and test infrastructure. Storage contracts expose request/reply persistence, dedupe identities, delayed messages and shard-wide recovery. This is a strong substrate for our framework, but it is not already our entire actor database/turn product.

## Explicit durable messaging

The example's default messages are volatile. Our mutating command adapter must add `ClusterSchema.Persisted` deliberately. A test must prove a submitted command remains available after both the sender and target process exit. Queries can have a different documented path; using a volatile operation for business mutation is not an accidental optimization.

## Ownership

Cluster decides where an entity should run. The actor DB fence decides who can commit there. Current `SqlRunnerStorage` source includes reserved-connection lifecycle/hardening; do not assert an old split-brain report remains unfixed without checking the chosen revision. Independently run stale-owner tests against our combined stores.

## PostgreSQL connections

Runner storage uses session-sensitive operations in relevant modes. PlanetScale PgBouncer transaction pooling cannot be assumed to preserve session locks. Use direct/session-affine connections for that role, bound the connection budget and test reconnect/lease loss. Ordinary mailbox queries may use a separate compatible pool.

## Per-actor DB mismatch

MessageStorage performs shard-wide recovery queries. Splitting it into millions of private actor DBs would require an additional directory/index/fan-out design. Keep cluster delivery metadata in PostgreSQL; keep actor receipts and domain commits local. Add the recoverable bridge instead of forcing the SQL message store into one DB per actor.

## Hosting topology

Every runner needs a unique reachable transport identity. A single load-balanced Railway service hostname for multiple replicas does not identify one owner. Pilot with explicitly addressable services or implement/test a supported registry/per-replica address arrangement. No global placement claims before this is proven.

## Integration acceptance

Persistent/volatile distinction; one actor sequential mutations; duplicate request after lost reply; owner transfer with blocked connection; two candidate activations; session loss; graceful drain; per-version routing; backpressure; reconnect from client-only gateway; cold activation after no in-memory entity state.

## Sources and evidence

- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [E03: SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts) — Reserved/rebuildable PostgreSQL connection and advisory lock behavior; assess current hardening, not an old issue headline.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [P01: PlanetScale PostgreSQL pooling](https://planetscale.com/docs/postgres/connecting/pgbouncer) — Transaction pool on port 6432; session-sensitive locks require suitable direct/session connection.
- [P04: PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html) — Session-level and transaction-level advisory locks have different lifetime requirements.
- [D02: Railway private networking](https://docs.railway.com/guides/private-networking) — Must validate per-replica identity/routing, not use one load-balanced address as runner identity.
