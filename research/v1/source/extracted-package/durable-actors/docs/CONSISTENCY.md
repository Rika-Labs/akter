# Consistency model

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Authoritative operations

One actor is the serialization boundary for committed mutations. The standard runtime processes one mutating turn at a time per actor and fences writes at storage. Multiple distinct actors may proceed concurrently. This does not make all cross-actor reads a single snapshot, and serialization alone does not prevent a logically stale user edit from overwriting a newer edit. Use expected revisions when the domain needs optimistic concurrency.

`request` waits for a retained outcome; `send`/`submit` acknowledges durable acceptance. A caller timeout is not evidence that the command failed. The caller can query by submission ID rather than creating a new operation. Cancelling a wait is separate from cancelling durable work.

## Projections

The actor DB is authoritative. A PostgreSQL projection and a materialized projection actor are derived, eventually consistent copies. Return projection freshness metadata: source/sink watermark, last successful application time, blocked state and optional receipt token. Never silently convert an eventual query into an authoritative approval decision.

A receipt token can support read-your-write waiting for a known actor command. It is not a global causal snapshot across all actors. Define what a timeout returns: `ProjectionNotCaughtUp`, not an empty result presented as current truth.

## Cross-actor operations

Reservations and multi-entity state transitions are protocols. An order can ask inventory to reserve units with an idempotent reservation ID, then confirm or release it. There is no atomic rollback across their databases. Compensations are business actions and can fail independently. Avoid cyclic waits and remote calls while holding an actor write transaction.

## Ordering

Guarantee committed order per source actor and explicit ordering within one local transaction. Network arrival time, wall-clock timestamps and transport sequence IDs do not create a global order. Projection consumers either apply source events in order with a contiguous checkpoint or retain per-row revision/tombstone logic sufficient for out-of-order replay. A single `max(sequence)` over arbitrary reordered events is unsafe.

## Data-access modes

| Path | Consistency promise |
|---|---|
| Actor mutation | Fenced local transaction |
| Actor authoritative query | Compatible current activation / primary DB |
| Shared projection query | Eventual, lag inspectable |
| Projection-actor query | Eventual; another application checkpoint |
| Cache | Disposable optimization, potentially stale |
| Live broadcast | Best effort; no history implied |
| Retained event feed | Ordered per actor, replay within retention |

These are proposed contracts to validate. They are not automatically inherited from merely choosing Effect, Turso and PostgreSQL.

## Sources and evidence

- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
- [Q02: SQLite transaction model](https://www.sqlite.org/lang_transaction.html) — Write transaction and locking semantics; supports analysis of local receipts/fence checks.
