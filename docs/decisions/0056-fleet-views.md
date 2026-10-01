# ADR 0056: Fleet views: `Fleet.view`, maintained from the change feed

**Status:** accepted (2026-09-30, Dallen; proposed 2026-09-29). It gates M6.3 ([#299](https://github.com/Rika-Labs/akter/issues/299) drafts it), reserves migration `0025_fleet` (the M6 slice table listed none), and follows [ADR 0055](0055-query-observation.md) (M6.2). It is the second half of the second item of [ADR 0014](0014-adoption-observation-and-client-reach.md)'s order. When accepted it amends [contract 06](../contracts/06-storage-ownership.md), [contract 10](../contracts/10-security.md), [ADR 0011](0011-direct-commands-outbox-and-performance.md) (which left the engine open), [ADR 0027](0027-served-protocol.md) section 1, [ADR 0049](0049-observability-names-metrics-and-defect-spans.md)'s metric list, the [post-foundation sketch](../api/post-foundation-sketches.md), and the migration tables in [M6](../milestones/M6.md) and the [milestone index](../milestones/README.md).

**Responsibility:** decide how a query that spans many actors is declared, which engine maintains it, what its change feed is, what it guarantees, and who may read it.

**Authority:** design decision record.

**Owner role:** database/runtime.

**Change policy:** supersede through a new ADR.

## Context

[Contract 06](../contracts/06-storage-ownership.md) says reads beyond a placement group "MUST use declared `Fleet.view` definitions." [ADR 0006](0006-scale-rules-placement-and-query-tiers.md) makes the fleet the third query tier: explicit, eventually consistent, never on the turn path, each derived row carrying its `routing_key`, actor version, and source LSN, with replication-slot lag as a monitored objective. [ADR 0011](0011-direct-commands-outbox-and-performance.md) says views are "maintained incrementally from the change feed and read through `Fleet.subscribe`," and lists Electric SQL, Materialize, RisingWave, Feldera, and `pg_ivm` as candidates for the engine. [M3's CR.8](../milestones/M3.md) tells users the cross-order report is plain SQL outside any turn until `Fleet.view` exists.

None of it exists. `Fleet` is not in the code. What the code offers instead:

- **Local and group reads.** `rows` reads one actor's rows, and `group` reads the actors that share a routing key from one shard in one snapshot ([`tables/owned.ts`](../../packages/akter/src/tables/owned.ts), [`turn/rows.ts`](../../packages/akter/src/runtime/turn/rows.ts)). Tenant placement puts a tenant's actors on one routing key, so a tenant-wide join is a group read. Wider reads have no declared form.
- **Owned rows change only in turns.** `ScopedRows` mutations are the only writer of owned tables, inside the turn's transaction. A rolled-back turn leaves nothing to read. An adopted table ([ADR 0054](0054-existing-schema-adoption.md)) may also be changed by legacy writers.
- **No change feed.** The runtime keeps a gap-free event stream per actor (`actor_events`), with retention and per-source subscription cursors ([ADR 0026](0026-cross-actor-event-subscriptions.md)). It keeps no cross-actor commit order and no record of row changes. The event stream carries only what an actor chose to emit. [ADR 0052](0052-read-your-writes-commit-versions.md) defines `durable-version` as a WAL insert position of the primary. The Postgres image in `compose.yaml` runs the default `wal_level`, and CI's replica is physical.
- **A cross-actor projection exists for one tenant.** A routed subscription to an `Actor.singleton` (ADR 0026) delivers every event of a source type to one projection actor, transactionally, one turn per event.
- **Where it must run.** PGlite has no logical replication ([upstream issue](https://github.com/electric-sql/pglite/issues/575)), and on Neki each shard has its own WAL (ADR 0052's limit).

About the candidate engines (each described from its own documentation):

- **`pg_ivm`** maintains a view in the writer's own transaction, in `AFTER` triggers, and holds an `ExclusiveLock` on the view after a base table is modified under `READ COMMITTED`, so concurrent transactions that change the same view queue behind one another. It does not maintain views through logical replication.
- **Electric SQL** is a separate service that reads logical replication and serves _shapes_: one table with a `where` clause, cut down to columns. Joins and aggregates across rows are not shapes.
- **Materialize, RisingWave, and Feldera** are separate streaming systems with their own storage and operations.

## Decision

### 1. The engine is built into the runtime, and its unit of work is a group

The runtime maintains each view itself. Its change feed is Postgres logical decoding of the tables the views read. Its algorithm is: for every group a committed change touches, recompute that group's aggregates from the source table, and upsert or delete that group's derived row. That is incremental at group granularity: work follows the groups that changed, never the table.

Recomputing a group is idempotent, so the feed needs no exactly-once machinery. A batch replayed after a crash writes the same rows, and a batch applied late reads current data.

### 2. `Fleet.view` declares a group-by over one owned table

```ts
const OrdersByStatus = Fleet.view("OrdersByStatus", {
  from: OrderRows,
  where: { archived: false },
  groupBy: ["status"],
  select: { orders: Fleet.count(), total: Fleet.sum("amountCents") },
})

Actors.layer({ database, fleet: [OrdersByStatus] })
```

- **`from`** is an owned table ([`Actor.table`](../../packages/akter/src/tables/owned.ts)) or an adopted one (ADR 0054), of an actor type with tenant placement. `where` is `ScopedRead`'s filter algebra, `groupBy` names business columns, and `select` names aggregates: `count`, `sum`, `avg`, `min`, `max`. That is the same single-table select the `group` capability already rebuilds and validates ([`turn/rows.ts`](../../packages/akter/src/runtime/turn/rows.ts)), with a tenant-first group key. No SQL, joins, subqueries, or window functions. Anything else does not type-check, or is refused at startup.
- **The view is a table.** `OrdersByStatus.table` is a Drizzle table with columns `tenant_id`, the group columns, the aggregates, and `as_of`, primary key `(tenant_id, …group columns)`, and the `durable_tenant` policy ([ADR 0051](0051-row-level-security.md)). The application puts it in its `drizzle-kit` schema like an owned table. Reading it with plain SQL is allowed, as any application read of its own tables is, and bypasses `authorize`. `Fleet.subscribe` is the framework's authorized read.
- **`tenant_id` is always the first group key.** A view never aggregates across tenants (Q2).
- **The source's tenant placement is required.** A tenant's rows then share one `routing_key`, so recomputing a group is one single-shard indexed read, `routing_key = tenantRoutingKey(tenant) AND tenant_id = … AND <group columns>`. Startup refuses an actor-placed source, and an index that does not lead with `(routing_key, tenant_id, …group columns)`, and prints the `CREATE INDEX`.
- **Registration is a layer option,** not a new noun. `Fleet.view` and `Fleet.subscribe` are the names the API already settles ([naming](../api/naming.md)).

### 3. The change feed is one logical replication slot

- **Setup is an operator step,** like ADR 0051's role script: `durable fleet setup --entry … --database-url …` requires `wal_level=logical` and runs, as a role that may, `ALTER TABLE <source> REPLICA IDENTITY FULL` for each source, `CREATE PUBLICATION durable_fleet FOR TABLE …` (insert, update, delete, truncate), and `pg_create_logical_replication_slot('durable_fleet', 'pgoutput')`. `REPLICA IDENTITY FULL` is required because an update that moves a row between groups must tell the maintainer the old group. The default identity carries only the primary key, and would leave the old group's derived row stale forever. The cost is WAL volume for updates, which the `fleet` benchmark scenario measures (Evidence).
- **The runtime refuses to start** when a registered view's source is not in the publication, the slot is missing or lost, a source does not have full replica identity, or the runtime's login lacks the `REPLICATION` attribute the slot functions need. Each refusal names the fix.
- **One maintainer runs at a time.** A runner holds a session-level advisory lock, `akter/fleet`, on one dedicated connection and runs the slot's `pg_logical_slot_peek_binary_changes`, the apply, and `pg_replication_slot_advance` on that same connection. A runner that loses the connection loses the lock and stops. Every other runner retries the lock every few seconds, so a dead maintainer is replaced in seconds. The SQL functions need no replication-protocol client. A streaming client is a later optimization (Q7).
- **A batch is peeked, applied, then advanced.** The maintainer decodes committed transactions in commit order, collects the touched `(tenant, group)` keys (old and new tuples), recomputes each with one query, and writes the derived rows in one transaction, deleting a row whose count is zero. It advances the slot only after that transaction commits. A crash between the two replays the batch, which is harmless (section 1). Each peek asks for at most 500 changes, and always ends on a transaction boundary.
- **A poll interval, not a stream:** the maintainer polls every 200 ms when idle. Freshness is that plus the batch's apply time. No SLO is claimed before the benchmark (Q9).
- **Nothing on the turn path.** A turn writes nothing for a view and pays no statement for it. The only turn-side cost is the WAL volume of full replica identity. The Statements gate stays unchanged.
- **External consumers use their own slots.** Cross-tenant analytics in ClickHouse, Iceberg, or a streaming engine ([ADR 0006](0006-scale-rules-placement-and-query-tiers.md)) may read a publication of their own. The framework does not depend on them or promise their consistency.

### 4. Guarantees, stated

- **Eventually consistent, never atomic across groups or views.** A view reflects committed changes only, because logical decoding emits only committed transactions, so a rolled-back turn appears nowhere. It reflects each group at some point at or after that group's last processed change.
- **Freshness is visible.** Migration `0025_fleet` adds `actor_fleet_views (view_name PRIMARY KEY, source_schema, source_table, definition_hash, status, applied_lsn, updated_at_ms, last_error)`, with `status` one of `building`, `ready`, or `stale`. It is a framework table with no `tenant_id`, like `actor_deployment` and `actor_tables`, so it carries no policy and has no `durable` view (contract 06 requires a view's rows to carry a tenant). The maintainer updates `applied_lsn` once per batch, which is off the turn path. A derived row's `as_of` is the end LSN of the batch that last wrote it.
- **The LSN is `durable-version`'s unit.** A command's token is a WAL insert position at or after its commit. A view has certainly seen that command when `applied_lsn` is at least the token. A lower `applied_lsn` proves nothing, so the comparison is conservative. `Fleet.subscribe` results carry the view's `applied_lsn` as `asOf`, and a caller may compare. A subscription does not wait for a token (Q8).
- **A view whose definition changed is stale.** Startup compares `definition_hash` and marks it `stale`, and a new view starts `building`.
- **A poison group isolates its view.** If a recompute fails deterministically (a `sum` overflow, say), that view is marked `stale` with `last_error`, its other groups stop advancing, and the maintainer continues with the other views. One view's defect never stops the slot. Readers see `stale: true` and a frozen `asOf`. This mirrors [ADR 0026](0026-cross-actor-event-subscriptions.md)'s poison-delivery rule, where a person decides.

### 5. Building and rebuilding

`durable fleet rebuild <View>` (and startup, for a `building` or `stale` view when Q5's default holds) recomputes every group from the source, in keyset batches by tenant, on the maintainer's connection and interleaved with change batches. Each recompute reads current data, and the maintainer is the only writer, so a rebuild converges while writes continue. It sets `ready` when the last batch finishes. A **lost slot** (invalidated because `max_slot_wal_keep_size` was exceeded, or dropped) marks every view `stale`. `durable fleet setup` recreates the slot, and the same rebuild follows.

### 6. `Fleet.subscribe`

- **Route.** `GET /fleet/{View}?{groupColumn}={value}&limit=` answers `text/event-stream`, in [ADR 0027](0027-served-protocol.md) section 1's table. It takes equality filters on group columns and a limit (default 100, at most 1,000), and returns the caller's own tenant's rows in group-key order.
- **Framing** is [ADR 0055](0055-query-observation.md)'s: `event: result` with `{ asOf, stale, rows }` as `data`, the latest result wins and identical results are not sent, `end` on an error, and no resume, because a fleet subscription is state.
- **Refresh.** Each runner polls `actor_fleet_views.applied_lsn` for each view it has subscribers of once per second, one single-row read per view however many subscribers, and reruns a subscription's page query only when it advanced. No runner-to-runner message is needed (Q4).
- **Authorization.** `authorize` gets a new `kind: "fleet"` with `command` the view name, then `kind: "reauthorize"` with `of: "fleet"` every `policy.reauthorizeEvery`. The tenant is the caller's, from `Actor.auth`, and no request parameter names one. With row-level security on, the page query runs as the role with `durable.tenant` set. The maintainer writes every tenant's derived rows as the connecting role, which the policies exempt like framework maintenance ([ADR 0051](0051-row-level-security.md)). Startup refuses a derived table that the tenant role owns.
- **Clients.** The Promise client gets `fleet.OrdersByStatus.subscribe(filter?, options?)` returning an `AsyncIterable`, and the in-process form returns a `Stream`.
- **Limits.** At most 1,000 subscriptions per view per runner, else `503 RunnerAtCapacity`.

### 7. Observability

Two gauges per view join [ADR 0049](0049-observability-names-metrics-and-defect-spans.md)'s set, following its naming: `akter.fleet.lag_bytes` (`pg_current_wal_lsn()` minus the slot's `confirmed_flush_lsn`) and `akter.fleet.lag_ms` (time since the maintainer last drained the slot), labelled by `view` only. The maintainer's counters are `akter.fleet.groups_recomputed` and `akter.fleet.batches`. Like the other sampled gauges they exist on the runner holding the lock. Alert on lag, on a `stale` view, and on retained WAL, because an unread slot pins WAL until `max_slot_wal_keep_size` drops it. The runbook says so.

## Open questions and recommended defaults

**Q1. A framework table for per-view state?** Default: yes, `actor_fleet_views` in `0025_fleet`. A view's status, definition hash, and progress have to live somewhere a maintainer failover can read. Rejected: a marker row inside the derived table (it would appear in reads, and a view with no groups could not be told from an unbuilt one) and a table comment.

**Q2. Cross-tenant views?** Default: no in this cut. Views group by tenant first and `Fleet.subscribe` returns only the caller's tenant. [ADR 0026](0026-cross-actor-event-subscriptions.md)'s alternatives table says `Fleet.view` serves cross-tenant reads, and this ADR narrows that until an operator capability exists. When it does, it would be an [ADR 0050](0050-operator-authority-and-audited-repair.md) action (`fleet.read`, tenant `"*"`) with an audit row, never an application credential. Cross-tenant analytics keep using external CDC consumers.

**Q3. Joins and multiple source tables?** Default: no. One source table, one group-by. A join needs a maintained delta per side or a recompute over a join, both of which change the cost model. `group` reads still join within a tenant on demand.

**Q4. Push or poll to subscribers?** Default: poll `applied_lsn` once a second per view per runner. It adds no messaging path and stays correct across runner restarts. A runner-to-runner message on each batch ([ADR 0006](0006-scale-rules-placement-and-query-tiers.md)'s "wakeups are messages, polling is correctness") is an optimization when a second's freshness is not enough.

**Q5. Rebuild automatically?** Default: yes, for `building` and `stale` views, one at a time, throttled to `rebuildBatch` groups per second (default 200) so a rebuild does not starve change batches. Rejected: manual only, which leaves a lost slot as a page instead of a recovery. `durable fleet rebuild` remains for definition changes an operator wants to run at a chosen time.

**Q6. Views over events?** Default: no. A view over `actor_events` would only see what actors emit, and gaps arrive with retention. Projections that need event semantics are routed subscriptions to a projection actor (ADR 0026), which stay the tool for authoritative, transactional, per-tenant projections.

**Q7. Streaming replication protocol instead of peek and advance?** Default: no in this cut. The SQL functions run on the pool's own client, and the maintainer's latency is one poll. A `START_REPLICATION` client lowers idle latency and is a client-only change later.

**Q8. Read-your-writes on a fleet view?** Default: no wait. A subscription returns whatever `applied_lsn` is, and the caller decides with a token. A waiting variant would put a slow view on a caller's critical path, which ADR 0006 forbids for the fleet tier.

**Q9. A freshness objective?** Default: none until T15 measures the maintainer. The tier says "eventually consistent," and this ADR claims a measured lag, not a bound.

**Q10. Embedded and hosted?** Default: PGlite refuses `Fleet.view` at layer build, because it has no logical replication. Neki gets no claim: its shards each have a WAL, so one slot and one order do not span them, and it needs provider evidence ([AGENTS.md](../../AGENTS.md)).

## Alternatives

- **`pg_ivm`.** Rejected: it maintains the view inside the writing turn, which puts view cost on the turn path, and its view lock queues concurrent turns that change the same view, the kind of serialization point [ADR 0006](0006-scale-rules-placement-and-query-tiers.md) prohibits. It is an extension the deployment must install, and it does not follow logical replication.
- **Electric SQL.** Rejected as the engine: shapes are row subsets, not aggregates, and it is a second service between the application and the database. It remains a good way to sync a tenant's rows to clients, outside the framework.
- **Materialize, RisingWave, Feldera.** Rejected as the framework's engine: each is a separate system with its own storage, and `@rikalabs/akter` is one package over Postgres. A deployment that wants one can consume a publication of its own.
- **In-turn change rows** (an outbox row per touched group, written by the turn). Correct without decoding, and works on PGlite and any provider, but it adds statements to the turn on every write, a hot row per group, and a second write path for every owned table. That breaks the Statements gate and the "never on the turn path" rule. Revisit only if logical decoding proves unavailable where the framework must run.
- **A projection actor per tenant** (ADR 0026). Kept for authoritative projections, but each event is a turn on one mailbox, the result is only what actors emit, and it costs turn capacity. A view is derived data read outside turns.
- **Periodic full refresh** (`REFRESH MATERIALIZED VIEW`). Simple, but every refresh costs the table, and freshness worsens as the table grows. It is the fallback when no slot is possible, and this ADR does not offer it (Q10).
- **Delta maintenance** (`count += 1`, `sum += x`). Cheaper per change for huge groups, but it needs an exact once-only apply, a per-view checkpoint written with every batch, and a retraction rule for `min` and `max`. Recompute per group has none of these. Revisit if group size makes recompute the bottleneck.

## Consequences

- A tenant can ask "orders by status" or "revenue by region" across every actor it owns, live and authorized, without a hand-written cross-actor query on the turn path and without a second data store.
- The deployment needs `wal_level=logical`, a `REPLICATION` login for the runtime, a publication and slot, and `REPLICA IDENTITY FULL` on source tables. That is a real operating change: an unread slot pins WAL, and the runbook and the lag alert are part of the feature.
- Update-heavy source tables write more WAL. The `fleet` benchmark measures it.
- Recompute cost is proportional to the size of a touched group, so a view that groups a huge tenant into a few groups costs O(group) per batch. The index requirement makes it one indexed read. The design's answer to a hotter case is delta maintenance later.
- A rebuild is always available and always correct, so a lost slot or a changed definition is an operation, not data loss.
- One migration is added (`0025_fleet`). The M6 slice table and the milestone index, which listed none for M6.3, gain it.
- `authorize` gains `kind: "fleet"`, and a hook that denies kinds it does not know denies it until updated.
- Adopted tables gain a reader that does see legacy writers: the WAL carries every writer, where a `watch` cannot ([ADR 0055](0055-query-observation.md)).

## Evidence

`conformance/fleet.ts` runs on real Postgres started with `wal_level=logical` because logical decoding needs a real server, so `compose.yaml` and the CI database service need that setting when M6.3 lands. Cases that need independent connections or a kill are marked. Each fails when the mechanism it names is removed:

- `every aggregate equals a recompute over the source after inserts, updates, deletes, and the removal of a group's last row, per tenant`;
- `an update that moves a row between groups changes both groups` (fails without full replica identity);
- `a rolled-back turn changes no view`, and `a legacy writer's change to an adopted table appears in the view`;
- `a maintainer killed between applying a batch and advancing the slot replays it and the view still equals the recompute` (real SIGKILL);
- `of two runners exactly one maintains, and the other takes over within the retry interval after the first is killed` (Postgres, two runners);
- `a lost slot marks every view stale and a rebuild restores them while writes continue`;
- `a changed definition marks its view stale, and a new view builds from the existing rows`;
- `a poisoned view goes stale and the other views keep advancing`;
- `applied_lsn passes a command's durable-version after the view has seen its change, and never moves back`;
- `startup refuses: wal_level below logical, no publication or slot, a source without full replica identity, an actor-placed source, a missing index, a login without REPLICATION, a derived table the tenant role owns`, and `PGlite refuses Fleet.view at layer build`;
- `subscribe sends the caller's tenant's page first, then a changed page after a commit, suppresses an identical page, and shows stale and asOf`;
- `subscribe denies at open, ends within reauthorizeEvery after revocation, never returns another tenant's rows, and with row-level security on runs as the tenant role`;
- `one poll per view per runner regardless of subscriber count` (statement counts);
- `the statements of a turn are unchanged when views are registered` (**Fleet: never on the turn path**);
- `0025_fleet applies`, and an OpenAPI case in `conformance/http.ts` for `GET /fleet/{View}` as `durable.fleet.<View>` with `x-durable-transport: "sse"`.

The fleet check names these. A `fleet` benchmark scenario (proposed for T15's pass; M6.md lists only `watch` fan-out and cold start there) measures WAL bytes per update with and without full replica identity, maintainer throughput against group size, and freshness against batch size, and its results go to [performance](../verification/03-performance.md).

## Revisit when

- Group size makes recompute the bottleneck (delta maintenance, Q3's joins).
- A deployment cannot run logical decoding (in-turn change rows, or an external engine as a supported target).
- Neki evidence exists for a per-shard slot and a cross-shard order.
- Operators need cross-tenant views (Q2).
- One-second freshness is not enough (Q4, Q7).
