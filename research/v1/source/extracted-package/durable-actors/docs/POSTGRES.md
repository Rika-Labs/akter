# Control PostgreSQL and PlanetScale

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Roles

PostgreSQL stores runtime/control records: persistent delivery, retained replies, runner coordination, actor database catalog, provisioning/work relay tasks and bounded operational metadata. Application projections go to a separately configured customer-owned database; the platform does not host arbitrary customer schemas by default.

## PlanetScale selection

PlanetScale Postgres is the preferred managed pilot based on the user's infrastructure direction. This is conditional on a direct-session connection test with Effect Cluster RunnerStorage, regional latency measurement, backup/recovery plan and actual cost quote. Neki remains a later scale option, not a day-one architecture dependency.

## Pooling

PlanetScale documents transaction-pooled PgBouncer and a direct endpoint. The inspected SqlRunnerStorage implementation can use session-affine advisory locking and a reserved connection. Use a direct/session-affine route for that role; never assume the generic pooled connection is safe. Apply separate connection budgets for coordination and ordinary mailbox queries. Test a disconnect during ownership and inspect the actual lock lifecycle.

## Scaling

Shared control tables are indexed for shard/due/actor/message access, not arbitrary global scans. Keep payloads bounded and archive old receipts according to a dedupe contract. Database performance depends on write amplification, indexes, vacuum/history, hot actor contention and checkpoint patterns. Benchmark before adopting sharding.

If future Neki deployment shards by actor/application identity, confirm every control query, unique constraint, advisory lock and cross-actor mailbox transaction is supported. PostgreSQL wire compatibility is not semantic compatibility for all Cluster SQL/locking assumptions. Shard-local actor application transactions do not automatically make global mailbox scans or runner coordination shard-local.

## Operations

Backups are not sufficient alone: practice restores with actor database incarnations and receipt retention. Encrypt traffic, rotate roles, separate migrations from runtime permissions, and prevent application code receiving the control DB credentials. Export metrics for pending messages, overdue timers, relay work age, connection waits and transaction retries.

## Alternative trigger

Switch provider if direct-session semantics, latency, quotas, failover behavior or cost do not satisfy measured needs. Ordinary managed PostgreSQL is the compatibility fallback. Avoid introducing distributed SQL merely for future scale without validating its locking/retry behavior against the selected Cluster source.

## Sources and evidence

- [P01: PlanetScale PostgreSQL pooling](https://planetscale.com/docs/postgres/connecting/pgbouncer) — Transaction pool on port 6432; session-sensitive locks require suitable direct/session connection.
- [P02: PlanetScale PostgreSQL pricing](https://planetscale.com/docs/postgres/pricing) — Instance, storage, replica and pooling costs need region/configuration-specific pricing.
- [P03: Neki preview](https://planetscale.com/changelog/neki) — Platform-preview announcement Sept 10 2026. Not selected for V1.
- [P04: PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html) — Session-level and transaction-level advisory locks have different lifetime requirements.
- [E03: SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts) — Reserved/rebuildable PostgreSQL connection and advisory lock behavior; assess current hardening, not an old issue headline.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
