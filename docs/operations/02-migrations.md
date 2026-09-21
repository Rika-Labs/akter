# Migrations

**Responsibility:** change runtime and application schemas safely.  
**Authority:** operational.  
**Owner role:** operations/database.
**Change policy:** a change requires operator review when a procedure or limit changes.

There are two migration systems:

- `packages/postgres` owns the hosted control-plane schema and migrations, executed by `bin/migrate.ts`.
- Each actor deployment owns its framework tables and actor-owned tables. Run them with `durable migrate`; relational changes are generated and applied with drizzle-kit.

Keyed actor state evolves through ordered `Actor.migration` upcasts. A turn decodes persisted `actor_state` through the chain after acquiring the generation fence and before invoking the handler. A missing or failing upcast is a deterministic defect: the turn rolls back and `onDefect` receives the cause.

Use expand, deploy, backfill, validate, and contract phases when old and new runners overlap. Do not contract a column, receipt shape, event schema, workflow payload, or effect payload until all compatible readers and retained records have passed its horizon.

Hosted Neki migrations must preserve `tenant_id` shard placement and the `actor_outbox` relay. Never assume every actor is awake or that tenant rows and `cluster_messages` share a transaction.

Before rollout, test the migration through `durable-actors/testing` against PGlite and Postgres; run the same conformance cases on Neki when hosted support is affected. Back up before destructive phases and record the rollback boundary.
