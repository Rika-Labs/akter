# Effect SQL — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Typed database access and transaction-scoped clients.

## Alternatives
Drizzle-first; raw SDK calls; custom ORM. Choose SQL core with optional Drizzle later.

## Selection rationale
Preserves Effect environment/error/resource semantics with less adapter code.

## Maturity
Versioned unstable SQL APIs require a pinned driver matrix.

## Performance
Measure transaction round trips and batching, not just query-building overhead.

## Developer experience
Parameterized SQL and repositories are clear; table descriptors can add metadata without a full ORM.

## Effect integration
Direct use; distinguish ControlSql, ActorSql and ProjectionSql.

## Bun integration
libSQL and Bun local adapters need separate transaction tests.

## Node compatibility
Portable client/service semantics with Node driver conformance.

## CI behavior
Codec, transaction, migration and consumer type tests.

## Local behavior
Local SQLite fixtures are useful but not remote provider evidence.

## Production behavior
Bind the same connection for fence, app mutation, receipt and outbox.

## Maintenance risk
Driver-specific behaviors can leak through a generic SqlClient surface.

## Licensing
Effect plus individual client driver licensing.

## Pricing
SQL abstractions do not change provider IO billing.

## Lock-in
Dialect/features are real coupling despite a generic client interface.

## Migration path
Use explicit migrations/export and backend conformance, not a claimed transparent swap.

## Known issues / uncertainties
A transaction cannot span Turso and PostgreSQL; custom Drizzle client may open another tx.

## Operational burden
Pool budgets, migrations and retry behavior remain owned.

## Security implications
Parameterized values, validated identifiers and isolated credentials are required.

## Sources
- [Effect libSQL package](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/sql/libsql/package.json)
- [Effect SQL client](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/sql/SqlClient.ts)
- [Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/reference)
- [SQLite transaction model](https://www.sqlite.org/lang_transaction.html)
