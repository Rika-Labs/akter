# 03 — Relational data

**Responsibility:** define relational storage, ownership, and tenancy intent.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

Durable Actors combines actor authority with ordinary relational data. Postgres remains the system operators can inspect, back up, migrate, join, and report on; the framework supplies a trustworthy mutation boundary.

Actors have two complementary storage forms:

- keyed state for small, schema-typed values used directly in turns;
- `OwnedTable` business tables for relational records, indexes, joins, and Drizzle queries.

State and rows share the command transaction. State migrations are declared as code-level upcasts; business-table migrations use normal SQL and Drizzle practices.

## Ownership and observation

```text
Actor authority: who may mutate a row
SQL observation: who may read and relate rows
Database schema: how business facts are represented
```

Turn contexts receive scoped write capabilities. Query, stream, connection, run, and wake contexts receive read-only capabilities. `ctx.db` remains the deliberate escape hatch for relational reads and joins; it does not erase tenant or actor ownership rules.

## Tenancy

There is one Postgres database per deployment, not one database per tenant. Every framework and business row carries `tenant_id`; composite indexes and optional row-level security reinforce isolation. `shardGroup` controls compute placement and can align with Neki data placement, but placement is not an authorization boundary.

## Safety boundary

The safe path must be the easy path:

- ownership columns come from trusted actor context;
- ordinary actor writes are scoped to the owning tenant and actor;
- reads never imply write authority;
- unsupported bulk or cross-owner mutations require an explicit privileged path;
- administrative repair remains separate from application handlers.

The goal is relational flexibility without turning every handler into a concurrency protocol. See [the product model](02-product-model.md) and [deployment](07-deployment.md).
