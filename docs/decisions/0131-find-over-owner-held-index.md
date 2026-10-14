# ADR 0131: `find` over the owner-held index

Status: accepted for the `default` tenant, 2026-10-12 (rewrite/0.2). General multi-tenant addresses remain a target, not established support.

**Responsibility:** decide how applications query across actors of one type, where the index lives, and what freshness a query promises.

**Owner role:** runtime and API.

## Context

0.1 offers three SQL query tiers (local, group, fleet), owned-table queries and `Fleet.view` projections maintained from a change feed ([ADR 0006](0006-scale-rules-placement-and-query-tiers.md), [ADR 0056](0056-fleet-views.md)). D8 keeps indexes and `find` in 0.2.0. The engine plan first put index rows in Postgres, applied by a consumer; with D18 there is no database, and D23 rule 3 removes the `index` member: `find` works over top-level scalar state fields.

## Decision

### 1. What is indexed

Every top-level scalar field of an actor's state is indexed: strings, numbers, booleans, literals, branded scalars and `DateTime`. Strings are truncated to their first 64 bytes (UTF-8) in the index. Lists, records, arrays and nested structs are not indexed.

### 2. Where the index lives

- The shard owner holds the index of its shard in memory: per actor type and tenant, sorted structures per indexed field.
- The owner updates the index when a segment becomes durable, from the durable states of the actors that segment changed, so the index never contains speculative values.
- The index is persisted as content-addressed index pages at each checkpoint and rebuilt on open from the checkpoint's index pages plus the tail.

### 3. The query

`X.find({ where, orderBy, limit })` is static on the contract and callable from clients and jobs, not from actions.

- `where` holds equality and range conditions (`eq`, `gt`, `gte`, `lt`, `lte`) on indexed fields, joined by conjunction. `orderBy` names one indexed field and a direction. `limit` is at most 1,000.
- String comparisons use the truncated 64-byte prefix: values that share a prefix compare equal, and ordering among them is by actor id.
- A result contains actor ids only. Indexed ordering values travel between trusted owners and the gateway for the merge; they are not client result fields.
- `find` is tenant-scoped: it returns only actors of the caller's tenant. It runs `access` once with kind `find` and no id.

### 4. Scatter-gather

The gateway sends the query to every shard of the store, each owner answers from its index, and the gateway merges by `orderBy` and applies `limit`. A shard with no owner is opened to answer, so a query on a scaled-to-zero store wakes all of its shards.

### 5. Freshness

Each shard's part of a result reflects every action that was durable on that shard when its owner answered, and nothing that was not durable. A caller whose action completed before it called `find` sees that action's effect. There is no snapshot across shards: two shards answer at different moments, so a result can include one actor's newer state and another's older state. `find` has no `after` token and no consumer lag.

## E7 implementation and evidence

`execution/indexes.ts` holds one row per created actor and sorted field structures. `Durable.record` updates them only after the live append or a verified replay; a failed action records its unchanged state. The checkpoint stores index rows in the same content-addressed page as the durable state, and both manifest page lists reference that hash. Recovery restores those rows and reprojects decoded state fields, so schema defaults and transformations cannot leave stale indexed values. The gateway authorizes once and peers return bounded normalized rows; the public Effect client receives only ids. String prefixes preserve all first 64 UTF-8 bytes, including a prefix ending inside a code point. Missing optional ordered values sort last in both directions.

[E7 evidence](../verification/e7-find-operators.md) covers held/lost appends, discarded drafts, crash/checkpoint/tail recovery, seeded split-owner moves, UTF-8 boundaries, limits, denied `find`, and real mTLS scatter-gather. The served runtime refuses non-default tenants rather than sharing an address. This promotes the default-tenant index/durability behavior, not general multi-tenant `find` or a production-provider guarantee.

## Supersedes and amends

- Supersedes [ADR 0056](0056-fleet-views.md) — scope: in full.
- Supersedes [ADR 0006](0006-scale-rules-placement-and-query-tiers.md) — scope: local, group and fleet query tiers.
- Amends [ADR 0050](0050-operator-authority-and-audited-repair.md): index inspection is an operator read ([ADR 0137](0137-inspection-audited-operations-telemetry.md)).

## Alternatives

- **An `index` member mapping state to a record.** Rejected by D23: indexing top-level scalars needs no declaration.
- **Index rows in Postgres written with the append.** Superseded by D18.
- **An index readable from the bucket without waking shards.** Deferred: it needs a query service over index pages; owners answer in 0.2.0.
- **A global snapshot across shards.** Rejected: it would need a cross-shard fence on every query.

## Consequences

- Index memory grows with actors per shard; very large stores may need paged indexes (revisit below).
- `find` latency is the slowest shard's; a cold store pays shard opens.
- Equality on long strings can return false positives beyond 64 bytes; applications that need exact long-string matching keep their own list.

## Evidence

| Milestone | Evidence                                                                                                                                                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E7        | Index consistency: after random actions, crashes and owner moves, every shard's index equals a recomputation from durable state; I2 for index contents; I8b (no result from another tenant); read-your-writes for `find`; scatter-gather with closed shards |

## Revisit when

- Memory per shard for the index becomes a measured limit (paged or bucket-resident indexes).
- Applications need `find` without waking a scaled-to-zero store.
- Compound ordering or more than one record per actor is required.
