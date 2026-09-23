# Runtime storage layout

**Responsibility:** organize framework-private durable records.  
**Authority:** design.  
**Owner role:** database/runtime.
**Change policy:** a change that alters a contract guarantee requires an ADR.

Each deployment owns one Postgres database per region; a single-region deployment has one. A tenant's rows live in its home region's database ([ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md)). Every framework and actor-owned application table includes `tenant_id`; composite indexes include tenant scope, and deployments may enable row-level security as an additional isolation control. Actor identity and generation complete the ownership key where applicable.

Every framework and actor-owned row also carries `routing_key bigint`: an XXH3-64 hash of a versioned encoding of the actor type's placement key. The placement key defaults to the tenant; an actor type may instead be placed per actor or with a parent actor. Rows sharing a placement key share a shard, which makes group queries single-shard snapshots. The encoding never changes for existing rows. Update-heavy framework tables avoid indexes on columns that change every turn and set a fillfactor below 100 so updates stay heap-only. See [ADR 0006](../decisions/0006-scale-rules-placement-and-query-tiers.md).

Core records include generation fences, command receipts, `actor_state` keyed values, actor-owned tables, events, timers, workflow executions, effects, dead letters, blobs, connections, and messages. Framework tables are protected from application mutation. Actor tables remain ordinary Drizzle tables automatically scoped by `ctx.rows`; initial `ctx.db` access permits authorized reads and joins, not advanced mutation. Every supported write adapter uses the same turn transaction and trusted ownership context.

`actor_state` stores one JSONB value per declared key and decodes through the actor's ordered `Actor.migration` upcast chain. Only dirty keys are written. Relational values belong in actor tables; binary data uses `actor_blobs` with actor-scoped `bytea` chunks and turn-bound writes. Table schema changes use drizzle-kit rather than state migrations.

On ordinary Postgres, turn intents may be inserted directly into `cluster_messages` within the turn transaction through the same `SqlClient`. On Neki, actor and business data are placed by a `range` shard index on `routing_key`, while `cluster_*` uses a single shard group; that group is the expected first global bottleneck and must be measured. Turn connections set `__neki.fanout='single'` so an accidental scatter fails. The agreed path writes `actor_outbox` in the actor's shard, then relays each committed intent to `cluster_messages` using a stable id and deduplicated handoff. A crash after source commit or destination insertion is recoverable without creating a new logical intent; receiver delivery remains at least once. Intents to an actor in another region use the same outbox and relay path.

Neki requires `shardLockDisableAdvisory: true`, generation-row locking, and `SET __neki.tx_mode='single'` on the connection that runs `BEGIN`. These are conformance requirements, not established provider behavior. Cluster-owned SQL layouts must be verified from the pinned Effect implementation; application tenant-column conventions do not imply that upstream Cluster tables contain the same columns.

Retention and restore must preserve dependency order between messages, receipts, events, workflow records, effects, and dead letters. See [data model](data-model.md), [transactions](transaction-catalog.md), and [retention](../operations/retention.md).
