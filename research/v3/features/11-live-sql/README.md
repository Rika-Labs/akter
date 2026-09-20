# 11 — Live SQL

**Status:** accepted product capability, including rerun and supported incremental maintenance; API and engine are proposed and unimplemented.

[Specification index](../../README.md) · [Decisions](../../DECISIONS.md) · [Sources](../../SOURCES.md) · [Ownership transfer](../10-ownership-transfer/README.md) · [Connection hibernation](../12-connection-hibernation/README.md)

## Product contract

Authorized clients can subscribe to relational query results. The product supports both:

1. **Invalidate and rerun:** changes mark a query dirty; the service reruns it and emits a new snapshot or diff.
2. **Incremental maintenance:** supported query shapes update materialized results from an ordered change stream without rerunning the whole query.

Incremental maintenance is approved scope, not optional research-only work. Its exact algebra and change source are undecided. Unsupported incremental shapes are rejected explicitly or use a caller-selected rerun mode; there is no universal incremental SQL promise.

```diagram
authorized SQL + bindings + mode
                │
                ▼
┌──────── planner / support checker ────────┐
│ auth scope · schema epoch · query algebra │
└──────────────┬─────────────────┬──────────┘
               │ rerun           │ incremental-supported
               ▼                 ▼
       invalidation index   ordered row changes
               │                 │
               └────────┬────────┘
                        ▼
              versioned snapshot/diff
                        ▼
                gateway connection
```

## Proposed API

`ctx.database` is directly yieldable Drizzle. Watching occurs outside mutation turns; a turn must not stay open for a subscription.

```ts
import { Actor, Context } from "durable-actors"
import { Effect } from "effect"
import { and, desc, eq } from "durable-actors/drizzle"
import { orders } from "./schema"

const program = Effect.gen(function* () {
  const ctx = yield* Context
  // The watch owns both the initial snapshot and its continuation boundary.
  const updates = yield* ctx.database.watch(
    ctx.database
      .select({ id: orders.id, status: orders.status, total: orders.total })
      .from(orders)
      .where(and(eq(orders.accountId, "acct_1"), eq(orders.open, true)))
      .orderBy(desc(orders.updatedAt), desc(orders.id))
      .limit(50),
    { mode: "incremental", key: orders.id },
  )

  return updates // Stream: initial snapshot, then patches or explicit resync
})
```

This illustrates desired ergonomics only. Query serialization, Drizzle AST support, yielded builder adaptation, and stream types have not been compiler-tested.

Realtime declarations remain inside `Actor.define`, with no separate registration:

```ts
export const Account = Actor.define({
  name: "account",
  subscriptions: {
    openOrders: Actor.liveQuery({
      input: AccountId,
      mode: "rerun",
      query: ({ accountId }) => Effect.gen(function* () {
        const ctx = yield* Context
        return yield* ctx.database.select().from(orders)
          .where(eq(orders.accountId, accountId))
      }),
    }),
  },
})
```

## Snapshot and cursor contract

Initial delivery is a versioned snapshot followed by changes after its cursor. If the service cannot bridge snapshot to stream without a gap, it discards and resnapshots. Cursors are opaque, scoped to query/auth/schema epochs, and expire after declared retention.

On cursor expiry, change-stream gap, overflow, topology change, or incompatible schema/auth change, the server emits `resync-required`; the client obtains a fresh authorized snapshot. It must not pretend continuity.

Stable row identity is required for patches. Composite keys are encoded canonically. If no stable key can be established, the mode emits whole snapshots or is rejected. `NULL` follows SQL three-valued logic and ordering rules, not JavaScript equality.

## Rerun semantics

Invalidations are hints and may coalesce. A durable change source or periodic repair must recover missed notifications. PostgreSQL `LISTEN/NOTIFY` alone is notification-only: payloads are not a durable log, disconnected consumers miss events, and it cannot establish snapshot continuity.

Rerun subscriptions report latest evaluated state; they do not promise every intermediate database state. Dependency extraction must be conservative. Unknown dependencies trigger broader invalidation or rejection, never silent staleness.

## Incremental semantics

The published support matrix must identify exact operators, data types, collation behavior, determinism requirements, and change-source assumptions. Candidate shapes include keyed selection/projection, supported equi-joins, grouped aggregates with reversible updates, and bounded ordered top-k—but none is claimed supported until gates pass.

Unsupported examples may include volatile functions, arbitrary user functions, recursive CTEs, unbounded windows, unsupported outer joins, nondeterministic ordering, or changes lacking before-images. `mode: "incremental"` rejects these with a structured explanation. No silent downgrade is allowed unless the caller selected `"prefer-incremental"`.

Correctness cases include:

- Inserts, updates, and deletes, including old and new values needed to retract prior contributions.
- Inner and supported outer joins when either side changes, including multiplicity and `NULL` extension.
- Aggregates under deletion and group-key movement.
- Top-k entry, exit, ties, and deterministic tie-breakers.
- Stable identity changes, treated as delete plus insert.
- Schema/type/collation changes that invalidate plans or encoded keys.
- Authorization changes that remove or add visible rows.

## Authorization and tenancy

Authorization is applied to initial snapshot, every maintained change, and resync. The subscription binds principal, tenant, policy version, query hash, and parameters. Shared plans may reuse computation only where they cannot cross authorization boundaries.

Revocation latency is a security contract. A policy epoch change pauses delivery, reauthorizes, and usually resnapshots; buffered rows from the old policy cannot leak afterward. Errors avoid revealing hidden row existence or cardinality.

## Backpressure and lifecycle

Each subscription has bounded queued bytes/events and a delivery deadline. Coalescing is legal for snapshot/rerun semantics; incremental diffs can be compacted only if the resulting state is equivalent. Beyond limits, send `resync-required` or disconnect—never grow memory without bound.

The logical subscription can survive actor sleep through the [connection gateway](../12-connection-hibernation/README.md). It does not keep command transactions or actor fibers alive. Reconnect deduplicates subscription identity and cursor.

## Neki limits

Neki cross-shard reads do not provide a global atomic snapshot. A fanout initial query and subsequent shard changes can reflect different times. The product must label this consistency, constrain subscriptions to one routed domain where required, or build a separate versioned change/snapshot protocol.

Neki compatibility with logical decoding, triggers, CDC, and required before-images is unverified. PostgreSQL protocol compatibility does not establish a usable change source. Notification-only approaches still miss disconnected intervals. See inherited [Neki evidence](../../SOURCES.md).

## Unresolved specifics

- Exact incremental algebra and explicit rejection matrix.
- Change source on Postgres and Neki, ordering, before-images, and retention.
- Snapshot/change handshake and cursor encoding.
- Diff wire format, stable key encoding, and client cache semantics.
- Join, aggregate, top-k, `NULL`, collation, and decimal behavior.
- Schema migration and authorization epoch coordination.
- Dependency extraction for reruns and repair scans.
- Tenant quotas, expensive-query admission, and shared-plan isolation.

## Falsifiable validation gates

1. Publish a finite algebra, then property-test incremental output against full rerun after randomized inserts, updates, and deletes.
2. Cover `NULL`, duplicate join keys, outer joins, group movement, top-k ties, stable-ID changes, and deterministic ordering.
3. Request every unsupported shape in strict incremental mode; each is rejected before subscription, never silently stale or downgraded.
4. Disconnect across change retention and drop notification delivery; reconnect either catches up durably or demands resync.
5. Race initial snapshots with writes; every accepted cursor yields a gap-free state or explicit resync.
6. Change schema and authorization while buffered updates exist; stale plans stop and unauthorized rows never escape.
7. Overrun slow consumers; memory remains bounded and final recovered state matches a fresh query.
8. Run on actual multi-shard Neki; document observed snapshot limits and reject guarantees the backend cannot provide.
9. Compare rerun mode under coalescing with its contract: latest state is correct without claiming intermediate states.

Passing these gates supports only the published query matrix, backend, schema epoch, and authorization model. It does not imply universal SQL maintenance.
