# 03 — Relational data

## Vision

Durable Actors should feel natural to teams that already use relational databases.

Teams should be able to:

- define ordinary tables and relationships;
- use familiar SQL and Drizzle semantics;
- inspect data with database tools;
- build reports and dashboards;
- query across actors when authorized;
- keep their existing relational system of record;
- run migrations using normal operational practices.

## The deliberate distinction

```text
Actor authority: who may mutate a row
SQL observation: who may read a row
Database schema: how facts relate to one another
```

The framework should not require a projection layer before state can be observed. Public-by-default actor state means queryable by authorized readers, not exposed to unauthorized tenants or anonymous users.

## The safety boundary

The framework must make the safe path the easy path:

- inserts receive ownership from trusted context;
- actor commands can mutate only owned rows;
- foreign-row mutation produces a clear error;
- unsupported bulk, join, cascade, and raw-SQL forms are rejected or explicitly privileged;
- reads do not grant write authority;
- administrative repair is separate from ordinary actor code.

Relational flexibility is a product strength only if the mutation boundary remains trustworthy.
