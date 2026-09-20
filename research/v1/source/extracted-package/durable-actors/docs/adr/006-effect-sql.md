# ADR 006: Effect SQL default, Drizzle optional

Date: 2026-09-17  
Status: Accepted

## Context
Core operations require transaction-scoped Effect SQL and typed errors. Building an ORM or wrapping an unrelated client risks losing the transaction context.

## Decision
Expose actor-scoped Database backed by Effect SQL. Keep table/projection descriptors limited. Offer Drizzle later only through a tested adapter.

## Alternatives considered
Drizzle-first provides query builder ergonomics but adds adapter/transaction compatibility work. A bespoke ORM is unnecessary scope.

## Consequences and risks
Users write parameterized SQL/repositories initially. Schema-to-DDL support must have explicit codecs and constraints.

## Validation and revisit trigger
Revisit only if an Effect-native SQLite ORM adapter demonstrably preserves our transaction boundary and materially improves users’ code.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Effect libSQL package](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/sql/libsql/package.json)
- [Effect SQL client](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/sql/SqlClient.ts)
