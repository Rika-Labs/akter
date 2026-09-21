# Runtime storage layout

**Responsibility:** organize framework-private durable records.  
**Authority:** design.  
**Owner role:** database/runtime.
**Change policy:** a change that alters a contract guarantee requires an ADR.

Each deployment owns one Postgres database. Every framework and actor-owned application table includes `tenant_id`; composite indexes include tenant scope, and deployments may enable row-level security as an additional isolation control. Actor identity and generation complete the ownership key where applicable.

Core records include generation fences, command receipts, `actor_state` keyed values, actor-owned tables, events, timers, workflow executions, effects, dead letters, blobs, connections, and messages. Framework tables are protected from application mutation. Actor tables remain ordinary Drizzle tables scoped by `ctx.rows`; advanced statements use the same transaction through `ctx.db`.

`actor_state` stores one JSONB value per declared key and decodes through the actor's ordered `Actor.migration` upcast chain. Only dirty keys are written. Relational values belong in actor tables; binary data uses `actor_blobs` with actor-scoped `bytea` chunks and turn-bound writes. Table schema changes use drizzle-kit rather than state migrations.

On ordinary Postgres, turn intents may be inserted directly into `cluster_messages` within the turn transaction through the same `SqlClient`. On Neki, actor and business data share tenant-local placement, while `cluster_*` uses a single shard group. The agreed path writes `actor_outbox` in the tenant shard, then relays each committed intent to `cluster_messages` using a stable id and deduplicated handoff. A crash after source commit or destination insertion is recoverable without creating a new logical intent; receiver delivery remains at least once.

Neki requires `shardLockDisableAdvisory: true`, generation-row locking, and `SET __neki.tx_mode='single'` on the connection that runs `BEGIN`. These are conformance requirements, not established provider behavior. Cluster-owned SQL layouts must be verified from the pinned Effect implementation; application tenant-column conventions do not imply that upstream Cluster tables contain the same columns.

Retention and restore must preserve dependency order between messages, receipts, events, workflow records, effects, and dead letters. See [data model](data-model.md), [transactions](transaction-catalog.md), and [retention](../operations/retention.md).
