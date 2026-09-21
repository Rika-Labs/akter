# Runtime storage layout

**Responsibility:** organize framework-private durable records.  
**Authority:** design.  
**Owner role:** database/runtime.
**Change policy:** a change that alters a contract guarantee requires an ADR.

Each deployment owns one Postgres database. Every framework and actor-owned application table includes `tenant_id`; composite indexes include tenant scope, and deployments may enable row-level security as an additional isolation control. Actor identity and generation complete the ownership key where applicable.

Core records include generation fences, command receipts, `actor_state` keyed values, actor-owned tables, events, timers, workflow executions, effects, dead letters, blobs, connections, and messages. Framework tables are protected from application mutation. Actor tables remain ordinary Drizzle tables scoped by `ctx.rows`; advanced statements use the same transaction through `ctx.db`.

`actor_state` stores one JSON value per declared key and decodes through the actor's ordered `Actor.migration` upcast chain. Only dirty keys are written. Large or relational values belong in actor tables or blobs. Table schema changes use drizzle-kit rather than state migrations.

On ordinary Postgres, turn intents may be inserted directly into `cluster_messages` within the turn transaction. Hosted Neki cannot assume a cross-shard transaction: the turn writes `actor_outbox` in the tenant shard, then the relay moves each committed intent to `cluster_messages` exactly once. A crash after commit is recovered by the next relay pass.

Retention and restore must preserve dependency order between messages, receipts, events, workflow records, effects, and dead letters. See [data model](data-model.md), [transactions](transaction-catalog.md), and [retention](../operations/retention.md).
