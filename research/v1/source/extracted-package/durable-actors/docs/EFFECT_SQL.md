# Effect SQL versus Drizzle

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Effect SQL is the default runtime database access layer because its transactions, typed errors, scopes and client services fit the rest of the runtime. Drizzle remains an optional application-facing adapter. Do not build a second rich ORM just to avoid writing a handful of parameterized queries.

## The Database service

Expose `const db = yield* Database` bound to the current actor. Internally preserve the Effect SQL transaction binding. Repositories use SqlSchema/Schema decoding for result validation and explicit storage codecs. Booleans stored as integers must be decoded; date values need deliberate wire/storage representations. A generic `<Row>` query type assertion is not runtime validation.

## Table metadata

The user's preferred Database.table/projected syntax describes supported columns, keys, indexes and projection configuration. It can compile migration SQL and trigger definitions. It must not imply that all Schema transforms, unions or services can map to relational types. The MVP can use handwritten migrations plus projection registration before introducing automatic DDL generation.

## Three SQL roles

ControlSql: shared PostgreSQL coordination. Database/ActorSql: actor-private libSQL. ProjectionSql: customer-owned destination. Use distinct service bindings. A transaction on one does not cover the others. Do not mix a raw Drizzle client and an Effect SQL client in the same correctness-critical unit without proving they share the same transaction connection.

## Drizzle option

The supplied documentation shows an Effect-native PostgreSQL integration. It does not establish an equivalent current Effect-native SQLite adapter. Before adding one, inspect its version/driver matrix. Wrapping a Promise with Effect.tryPromise can preserve typed expected errors; wrapping every rejection as a defect through Effect.promise is not an appropriate default for DB failures. A true native adapter must also preserve cancellation/resource/transaction semantics, not merely yield syntax.

## Migration ownership

Effect Migrator can supply execution primitives. Durable Actors still owns per-actor compatibility, lazy fleet rollout, fence protection, checksum immutability and source/sink version coordination. Migration execution against a driver is not a fleet migration strategy.

## Sources and evidence

- [E07: Effect libSQL package](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/sql/libsql/package.json) — Inspected rc.115 package depends on @libsql/client ^0.18.0.
- [E09: Effect SQL client](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/sql/SqlClient.ts) — Transaction and reserved-connection API reference; bind each database role independently.
- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
- [T03: Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/reference) — Inspect transactions, client disposal, protocol, and limitations for selected endpoint.
