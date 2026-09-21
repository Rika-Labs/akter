# Durable data model

**Responsibility:** define the durable records required by the runtime.  
**Authority:** design.  
**Owner role:** database/runtime.
**Change policy:** a change that alters a contract guarantee requires an ADR.

Framework-private records include:

| Record               | Purpose                                 | Authority         |
| -------------------- | --------------------------------------- | ----------------- |
| Generation           | fenced current writer                   | turn admission    |
| Receipt              | command id, input identity, stored exit | retry safety      |
| Message              | durable command or timer envelope       | delivery          |
| `actor_state`        | keyed schema values                     | small actor state |
| Actor table row      | relational actor-owned data             | application state |
| Event                | ordered committed publication           | replay and waits  |
| Effect / dead letter | post-commit external consequence        | effect recovery   |
| Workflow execution   | member run keyed by owner and key       | workflow recovery |
| Connection           | parked-session metadata                 | socket resumption |
| Blob                 | large actor-scoped bytes                | application state |
| `actor_outbox`       | Neki tenant-shard intent obligation     | relay recovery    |

One Postgres database belongs to one deployment. `tenant_id` appears on every framework and actor-owned table, with optional RLS. Actor state, tables, events, effects, blobs, and receipts share the actor ownership key and transaction boundary.

State schemas evolve through ordered `Actor.migration` upcasts during decode. Relational schemas evolve through drizzle-kit. Runtime records are not ordinary application mutation surfaces and have explicit retention and restore dependencies.

Workflow identity is `[deployment, tenant, actor, id, workflow, key]`. Singleton names and cron ownership are also deployment-scoped.
