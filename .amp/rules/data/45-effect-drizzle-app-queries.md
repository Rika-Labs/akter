---
enabled: true
paths:
  - apps/api/src/**
exclude: []
on: code-change
severity: warning
threshold: 0.9
priority: 10
---

# API repositories use Effect-native Drizzle queries

Application data access in `apps/api/src` uses
`drizzle-orm/effect-postgres` with the existing Effect `PgClient`. Database
reads, writes, and transaction boundaries use Drizzle's typed tables and
query builder, including a transaction for multi-step billing updates.

Violations: raw SQL statement strings in application handlers or repositories;
using a separate `pg` pool or `drizzle-orm/node-postgres` for API application
queries; splitting webhook deduplication and its billing update across
connections or transactions; checking membership only before a project write
without retaining authorization across that write.

Clean: SQL migrations and database construction in their owning packages;
Better Auth's own database adapter; Drizzle's comparison operators and
Effect-native transaction on the shared SQL client. Flag only a visible API
query or transaction regression, not underlying framework SQL or test fixtures.
