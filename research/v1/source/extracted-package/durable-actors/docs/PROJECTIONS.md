# Automatic projections

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Scope

A projected table remains actor-owned. The framework captures row mutations and asynchronously applies them into a configured application-owned sink. A projection is a derived read model; it is not a second authoritative database and it is not a synchronous cross-actor join.

The desired declaration is deliberately small:

```ts
// Proposed metadata API, not a new ORM.
const todos = Database.table("todos", {
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
}).pipe(Database.primaryKey("id"), Database.projected())
```

## Capture choices

**Chosen first spike: generated SQLite row triggers plus an actor-local change log.** The mutation and change record commit together. Capture works for repository helpers and ordinary raw SQL, provided writers honor the runtime connection and schema rules. Validate trigger/JSON/function availability on the exact Turso/libSQL engine. Framework interception alone misses out-of-band SQL. WAL decoding is engine-specific and is a much larger project.

V1 should support single-table insert/update/delete, explicit keys, fixed encodings, one PostgreSQL sink and a bounded set of codecs. No arbitrary incremental joins, migration inference, inverse transformations or multi-master conflict resolution.

## Change envelope

Every record includes application, environment, actor type/id, database incarnation, stable table identity, table schema version, source sequence, transaction ID and ordinal, operation, key-before/key-after, and enough before/after data for deletes and projection-key moves. Sequence numbers are encoded without JavaScript precision loss. Raw wall clock is diagnostic data, not ordering authority.

Projection sink identity must include actor namespace and local primary key. Two private DBs can both contain row `id=1`; merging solely on row ID corrupts data. Distinct applications with differently shaped `todos` tables never share an unversioned physical table by convention.

## Relay and application

Source local transaction commits -> durable discovery/relay task registered -> fetch ordered batch -> apply batch and sink checkpoint/receipt in one sink transaction -> acknowledge source retention position. A crash anywhere causes retry with the same change IDs. Batch sizes honor SQL parameter and transaction limits. At-least-once delivery does not imply duplicate visible aggregates: the sink receipt guard covers data and checkpoint atomically.

For ordered sources, advance only a contiguous checkpoint. For deliberately parallel row application, retain row revisions and deletion tombstones and prove the merge function. A `max(sequence)` checkpoint can drop delayed updates and is not accepted.

## Bootstrap and rebuild

A new sink requires a consistent source snapshot plus a change-log high watermark. Scan rows from that snapshot, then replay changes after the watermark with deduplication. If remote driver snapshot semantics cannot support this efficiently, coordinate a short actor pause or use a tested copy/export mechanism. Do not scan live data and independently read a watermark while claiming a consistent snapshot.

Create a new sink generation for rebuild. Backfill into staging tables, replay to a known barrier, then atomically switch the serving view within that sink. Persist progress so a worker restart does not start over. A retention gap raises `ResnapshotRequired`; do not silently skip it.

## Moving keys and deletes

Changing a source primary key or materialization key needs before and after images. Route a delete to the old destination and an upsert to the new destination with deterministic delivery IDs. The two destination commits are not atomic; clients may temporarily observe absence or duplication. Source actor deletion emits a durable namespace tombstone before physical deletion. Reusing an actor ID creates a new incarnation.

## Backpressure and failure policy

A customer database outage must not cause infinite outbox growth. Configure per-sink backlog bytes/age, per-application storage quotas, retry schedules and dead-letter inspection. Warn before a limit; then reject new writes affecting projected tables or explicitly pause projections under a data-loss acknowledgement. Never drop authoritative changes while reporting the sink healthy.

## Security

Projection opt-in is a data-export permission. Support field inclusion/exclusion and review PII/secret fields. Validate sink destinations to prevent SSRF or credential exfiltration; use TLS verification, destination allowlists, separate least-privilege credentials, rotation and audit. BYO DB means customer-owned schema, not arbitrary outbound network access from every actor.

## Effect integration

Effect SQL supplies parameterization and transaction access; Schema supplies envelopes/codecs; Stream processes batches; Schedule supplies retries. These primitives do not implement discovery, ordering, snapshot consistency, migration, or recovery for us. Those are the projection package's owned responsibilities.

## Sources and evidence

- [Q01: SQLite triggers](https://www.sqlite.org/lang_createtrigger.html) — Transactional row-trigger mechanism; OLD/NEW semantics; test compatibility with target engine.
- [Q02: SQLite transaction model](https://www.sqlite.org/lang_transaction.html) — Write transaction and locking semantics; supports analysis of local receipts/fence checks.
- [E09: Effect SQL client](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/sql/SqlClient.ts) — Transaction and reserved-connection API reference; bind each database role independently.
- [E06: Effect EventLog](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/eventlog/EventLog.ts) — Typed handler runs before journal entry commits; not interchangeable with a database CDC broker.
- [Q03: Electric Shapes](https://electric-sql.com/docs/guides/shapes) — PostgreSQL data distribution/filtering; not automatic capture from authoritative actor databases.
- [Q04: PowerSync architecture](https://docs.powersync.com/architecture/overview) — Backend-authoritative sync and client upload model; different authority direction from source actor databases.
- [Q05: Debezium outbox routing](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html) — Useful outbox transport pattern; not a ready-made actor-fleet discovery system.
