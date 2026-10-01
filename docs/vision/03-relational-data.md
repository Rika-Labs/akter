# 03 — Relational data

**Responsibility:** define relational storage, ownership, and tenancy intent.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

Akter combines actor authority with ordinary relational data. Postgres remains the system operators can inspect, back up, migrate, join, and report on; the framework supplies a trustworthy mutation boundary.

Actors have complementary storage forms in the same deployment database:

- keyed state for small, schema-typed values used directly in turns, stored compressed and opaque to SQL;
- `OwnedTable` business tables for relational records, indexes, joins, and Drizzle queries;
- `Actor.blob` declarations for actor-scoped `bytea` chunks in `actor_blobs`, accessed through `turn.blob`.

State, rows, and blob writes share the command transaction. Off-turn blob access is read-only; external object-storage APIs are not this blob surface. State migrations are code-level upcasts; business-table migrations use normal SQL and Drizzle practices.

## Ownership and observation

```text
Actor authority: who may mutate a row
SQL observation: who may read and relate rows
Database schema: how business facts are represented
```

`X.Turn` receives scoped write capabilities. `X.Read` and `X.Connection` receive read-only capabilities. `group` provides read-only joins across the actor's placement group; wider reads will use declared `Fleet.view` definitions ([ADR 0056](../decisions/0056-fleet-views.md)). Neither erases tenant or actor ownership rules.

## Tenancy

There is one Postgres database per deployment region, not one database per tenant. Every framework and business row carries `tenant_id`; composite indexes and optional row-level security reinforce isolation. Cluster sharding controls compute placement and `placement` controls which actors share a routing key for data placement, but placement is not an authorization boundary.

Queries come in three tiers. A local query reads one actor's rows. A group query reads actors that share a placement key (by default, one tenant) from one shard and one snapshot. A fleet query spans placement keys or regions; it is explicit, eventually consistent, and never runs inside a turn. The tiers keep a query's cost the same at 100,000 actors and at a trillion. See [ADR 0006](../decisions/0006-scale-rules-placement-and-query-tiers.md).

## Safety boundary

The safe path must be the easy path:

- ownership columns come from trusted actor context;
- ordinary actor writes are scoped to the owning tenant and actor;
- reads never imply write authority;
- unsupported bulk or cross-owner mutations require an explicit privileged path;
- administrative repair remains separate from application handlers.

The goal is relational flexibility without turning every handler into a concurrency protocol. See [the product model](02-product-model.md) and [deployment](07-deployment.md).
