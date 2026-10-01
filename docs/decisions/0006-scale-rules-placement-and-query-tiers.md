# ADR 0006: Scale rules, placement keys, and query tiers

**Status:** accepted design (2026-09-23); implementation, conformance, and benchmarks remain pending.

**Responsibility:** record the rules that keep turn, wake, and timer cost independent of how many actors a deployment stores.

**Authority:** historical decision record.

**Owner role:** runtime architecture.

**Change policy:** supersede through a new ADR when these rules change.

## Context

Rivet claims billions of actors per cluster. Its source code shows those are mostly idle SQLite databases stored as pages in a shared, ordered key-value store (UniversalDB). Horizontal scale on its enterprise tier comes from FoundationDB's range partitioning. Rivet documents its PostgreSQL backend as production-ready only up to roughly 1,000 concurrent actors ([storage](https://rivet.dev/actors/self-host/control-plane/storage/)).

Akter keeps one relational store per deployment region so that SQL can see across actors. That store scales like Rivet's only if every hot path touches one shard and does work proportional to the actors that are active, not the actors that exist. Two parts of the accepted design need clarification for that to hold:

- On Neki, actor data currently shares **tenant-local placement**. A deployment with one large tenant therefore cannot grow past one shard (roughly 10,000 turns/second and 15 TB, by the estimates in [performance](../verification/03-performance.md)).
- No query is yet assigned a consistency or cost tier. A join that runs locally at 100,000 actors becomes a scatter across every shard at a trillion.

## Decisions

### Every actor type has a placement key

An actor type's placement key decides which rows share a shard:

- `tenant`: all actors of a tenant share a shard. This is the default and preserves the current design.
- `actor`: each actor is placed independently, for high-cardinality types such as per-user or per-session actors.
- A parent actor's identity: child actors share the parent's shard.

The framework computes `routing_key`, a 64-bit hash (XXH3-64) of a versioned encoding of the placement key. It stores `routing_key` as `bigint` on every framework and actor-owned row. On Neki, all actor tables in a shard group use a `range` shard index on `routing_key`. On ordinary Postgres, `routing_key` supports hash partitioning when a single database needs it. The encoding is versioned and never changes for existing rows. Because the framework owns the hash, the same key works on Neki, ordinary Postgres, and any future sharding backend.

The public API for declaring a placement key is not specified here; it needs [API compatibility](../api/versioning.md) review.

### Hot paths are single-shard, and the framework enforces it

Every framework statement in a turn, wake, or due-work scan targets one `routing_key` range on one shard. On Neki, turn connections set `__neki.fanout = 'single'` in addition to `__neki.tx_mode = 'single'`, so an accidental scatter fails instead of silently slowing. CI checks framework queries with `EXPLAIN (NEKI_PLAN)`.

### Due-work scans cost what is due, not what is stored

Timers, delayed intents, and wake markers are indexed by `(bucket, due_at)`, where `bucket` is the high bits of `routing_key`. A runner scans only the buckets it owns. Sleeping actors with nothing due appear in no scan.

### Queries have three explicit tiers

| Tier  | Scope                                   | Execution                                                                             | Guarantee                                              |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Local | one actor's rows                        | its shard                                                                             | transactional in turns; committed snapshot elsewhere   |
| Group | actors that share a placement key value | one shard                                                                             | one snapshot; the group shares that shard's throughput |
| Fleet | anything wider                          | explicit scatter on dedicated connections, or CDC-fed analytics (ClickHouse, Iceberg) | eventually consistent; never on the turn path          |

Fleet queries require an explicit opt-in and are rate-limited. Cross-region queries under [ADR 0005](0005-turn-latency-batching-and-regional-placement.md) are fleet queries. The console and cross-tenant analytics read CDC-fed copies. Each derived row carries its `routing_key`, actor version, and source LSN; replication-slot lag is a monitored service objective.

### Patterns that serialize the whole database are prohibited on hot paths

- **`LISTEN/NOTIFY` on the turn or wake path.** Committing a `NOTIFY` took a database-wide lock in the PostgreSQL versions Recall.ai operated ([outage report](https://www.recall.ai/blog/postgres-listen-notify-does-not-scale)). Post-commit wakeups travel as runner-to-runner messages through Cluster routing, with durable polling as the correctness path.
- **Foreign keys from high-volume actor tables to shared low-cardinality parent rows.** Concurrent inserts referencing one parent create multixacts; Metronome exhausted multixact member space this way ([root cause analysis](https://metronome.com/blog/root-cause-analysis-postgresql-multixact-member-exhaustion-incidents-may-2025)).
- **More than one savepoint per command.** A transaction holds at most as many savepoints as the turn-batch cap.
- **Global sequences, counters, or rate limits** touched by every turn.
- **Indexes on columns that change every turn**, which prevent heap-only-tuple (HOT) updates. Update-heavy framework tables set a fillfactor below 100.
- **Network I/O inside a turn transaction**, already forbidden by the [transaction contract](../contracts/03-transactions.md). Turn transactions also carry a hard statement and transaction timeout.

### Idle actors move to a cold tier

Hosted deployments will offload the state and blobs of actors idle beyond a retention threshold to object storage, leaving a stub row; a wake rehydrates them. At a trillion actors with about 1 KiB of state each, hot replicated storage alone is roughly 4.5 PB, so a cold tier is required for cost, not throughput. The mechanism needs its own ADR before implementation.

## Alternatives

- **Keep tenant-only placement:** rejected; it caps a single-tenant deployment at one shard.
- **Neki's native `xxhash` shard index on raw columns:** rejected; a framework-owned hash is portable across backends and lets runners own contiguous ranges for due-work scans.
- **Replace `cluster_messages` with a per-actor append-only mailbox:** not adopted. It would avoid queue churn but conflicts with foundation F3 (persisted Cluster messages). Revisit if `cluster_messages` saturates.
- **Allow transparent scatter queries:** rejected; their cost grows with shard count, and Neki gives cross-shard reads no shared snapshot ([query planning](https://planetscale.com/docs/neki/query-planning#transactions-across-shards)).

## Consequences and evidence

The [storage layout](../architecture/03-storage-layout.md), [dispatch](../architecture/04-dispatch.md), [storage ownership](../contracts/06-storage-ownership.md), [support matrix](../operations/support-matrix.md), conformance, and [performance](../verification/03-performance.md) documents are updated to match. The Neki `cluster_*` tables remain in a single shard group; that group is the expected first global bottleneck and must be measured before a hosted scale claim.

No part of this ADR is implemented. The planning envelope in [performance](../verification/03-performance.md) consists of hypotheses, not product claims.

## Revisit when

- `cluster_messages` or its shard group saturates before actor shards do.
- Neki supports atomic cross-shard transactions or shared cross-shard snapshots.
- A workload needs snapshot joins across placement keys.
- Benchmarks show that turn, wake, or timer latency grows with stored actor count.
