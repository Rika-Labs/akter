# Materialized projection actors

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## A later specialization, not a kernel dependency

A projection actor maintains a read-only-to-app materialized view in its private database. Source domain actors remain authoritative. This is useful for a project board, device fleet summary or dashboard with its own subscriptions and derived state. It is not automatically faster than an indexed PostgreSQL query; routing, cold activation and remote DB hops may dominate.

```ts
// Proposed later API.
const ProjectBoard = ProjectionActor.make("ProjectBoard", {
  source: todos,
  key: row => row.projectId,
  target: boardRows,
  map: row => ({ id: row.id, title: row.title, status: row.status }),
})
```

Pure map/key descriptors are compiled into versioned deployed code. Their closures are not serialized into durable messages. Check source schema version and materialization version before applying an event.

## Routing options

The simplest first implementation consumes the same captured source change stream that feeds PostgreSQL. It need not read PostgreSQL and copy data back for each update. PostgreSQL is one sink and the projection actor is another. This avoids treating a customer-owned projection DB as part of our control plane.

If a user explicitly chooses PostgreSQL-derived joined views, that is a different connector: PostgreSQL CDC/query materialization -> target actors. Arbitrary joined-query incremental maintenance is not implied by `source: [todos, users]`. Start with a single source map/filter/key.

## Target transaction

The target actor atomically verifies the source change receipt/revision, updates target rows, updates any deterministic aggregate, records its application checkpoint and stages a durable view-change event. Duplicates do not double-count. Updates require both before and after contributions. Deletes retain tombstones long enough to prevent old inserts from resurrecting data.

The source primary key and actor namespace identify each materialized row. The target cannot assume all source databases use globally unique user row IDs.

## Indexes

Each target DB may use indexes suited to its reads, for example `(status, priority DESC, id)` or `(assignee_id, status, id)`. Stable tie-breakers make pagination deterministic. Do not stringify numeric priority into a lexicographic key and expect numeric ordering. Extra indexes increase write amplification and storage; benchmark against the direct PostgreSQL alternative.

## Operations

Rebuild into a new target generation, resume from source watermark, then switch serving generation. Target schema migrations, source retention gaps and key mapping changes need explicit handling. Do not let materialized target tables automatically re-enter the source projection pipeline: mark derived tables non-publishable by default to prevent feedback loops.

## Consistency and limits

A move from board A to board B is two eventual updates. A projection actor can itself be a hot key, with one serialized write stream. Many subscribers require gateway fan-out and bounded per-client buffers, not one durable subscription row per token/event indefinitely. For basic global lists, use the external projection DB directly.

## Sources and evidence

- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [Q03: Electric Shapes](https://electric-sql.com/docs/guides/shapes) — PostgreSQL data distribution/filtering; not automatic capture from authoritative actor databases.
- [Q04: PowerSync architecture](https://docs.powersync.com/architecture/overview) — Backend-authoritative sync and client upload model; different authority direction from source actor databases.
- [Q06: Materialize documentation](https://materialize.com/docs/) — Incremental views are a substantial specialized query engine; do not quietly implement one inside ProjectionActor.
