# Migrations

**Responsibility:** change runtime and application schemas safely.  
**Authority:** operational.  
**Owner role:** operations/database.
**Change policy:** a change requires operator review when a procedure or limit changes.

The actor design has three migration responsibilities:

- Framework SQL tables use Effect `Migrator`, with automatic boot migration or explicit manual migration selected through `Database` configuration.
- Application-owned relational tables use drizzle-kit migrations.
- Schema-decoded JSONB state in `actor_state` uses ordered `Actor.migration` upcasts. A turn applies the chain after acquiring the generation fence and before invoking the handler, then commits the current shape. Invalid chains fail at `Actor.make`; decode/upcast defects roll back the turn and invoke `onDefect`.

Separately, `packages/postgres` owns the hosted control-plane schema and `bin/migrate.ts`. The planned `durable migrate` command is not implemented. This document specifies required migration behavior, not a working CLI procedure.

Use expand, deploy, backfill, validate, and contract phases when old and new runners overlap. Do not contract a column, receipt shape, event schema, workflow payload, or effect payload until all compatible readers and retained records have passed its horizon.

Hosted Neki migrations must preserve `tenant_id` shard placement and the `actor_outbox` relay. Never assume every actor is awake or that tenant rows and `cluster_messages` share a transaction.

Before rollout, test the migration through `durable-actors/testing` against PGlite and Postgres; run the same conformance cases on Neki when hosted support is affected. Back up before destructive phases and record the rollback boundary.
