# Migrations

**Responsibility:** change runtime and application schemas safely.  
**Authority:** operational.  
**Owner role:** operations/database.
**Change policy:** a change requires operator review when a procedure or limit changes.

The actor design has three migration responsibilities:

- Framework SQL tables use Effect `Migrator`, with automatic boot migration or explicit manual migration selected through `Database` configuration.
- Application-owned relational tables use drizzle-kit migrations.
- Compressed schema-encoded state in `actor_state` uses the ordered migrations declared in `Actor.state(fields, { migrations })`. A turn applies the chain after acquiring the generation fence and before invoking the handler, then commits the current shape on handler success. An unhandled declared failure discards migration writes along with other business work while its failure receipt commits. Invalid chains fail at `Actor.make`; decode/upcast defects roll back the whole turn and record the cause in the turn span.

Separately, `packages/postgres` owns the hosted control-plane schema and `bin/migrate.ts`. The planned `durable migrate` command is not implemented. This document specifies required migration behavior, not a working CLI procedure.

Use expand, deploy, backfill, validate, and contract phases when old and new runners overlap. Do not contract a column, receipt shape, event schema, workflow payload, or effect payload until all compatible readers and retained records have passed its horizon.

Hosted Neki migrations must preserve `routing_key` shard placement and the `actor_outbox` relay, and run in every region of a multi-region deployment. Never assume every actor is awake or that rows on different shards share a transaction.

Before rollout, test the migration through `durable-actors/testing` against PGlite and Postgres; run the same conformance cases on Neki when hosted support is affected. Back up before destructive phases and record the rollback boundary.
