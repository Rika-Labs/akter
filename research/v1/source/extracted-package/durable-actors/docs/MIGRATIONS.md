# Migrations and rolling versions

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Rule

An actor runs code against a **compatible** schema version, not necessarily the newest schema ever deployed. Blindly migrating to latest breaks rolling deployments and rollback.

Store immutable migration IDs, content checksums, applied version, actor DB incarnation and code compatibility range. The migration ledger lives in the actor DB. Checksum mismatch is a deployment error; never edit an already applied migration.

## Rollout

Use expand -> compatible dual-version window -> backfill -> switch reads -> contract. A new nullable column is easier than changing a column's meaning in place. A destructive contraction waits until old code and queued protocol versions are no longer eligible.

Acquire ownership/fence before migration and stop processing commands until migration commits. Fail closed on unsupported schema. Per-actor lazy migrations avoid touching every sleeping database at deploy time, but migration-on-wake adds latency and possible failure. Bound concurrent migrations and expose backlog/failure status. Large backfills are durable jobs with checkpoints, not one giant activation transaction.

## Projection schema changes

Source schema and sink schema need versioned compatibility. Provision sink expansion before source emits the new encoding. A missing sink migration should pause that sink with a diagnosable failure, not block the authoritative actor immediately unless backlog quota is reached. Backfills need a snapshot/watermark protocol and tombstone preservation. Customer-owned databases require a least-privilege migration role separate from routine projection writer credentials.

## Protocol changes

Queued requests, replies, timers, activity completions and events outlive deployments. Include protocol versions and decode adapters. Keep activity completion routes pinned to supported code versions. Never depend on a serialized callback closure. Deprecation policy includes the maximum queue/event retention and the oldest accepted client version.

## Restore

Restoring only the actor DB can undo receipts while PostgreSQL still says requests were processed; restoring only control data can redeliver commands older than retained receipts. Restoration is therefore a coordinated operation with a new incarnation, explicit replay boundary and operator-visible decisions. Document which external effects cannot be rolled back.

## Testing

For every migration: fresh DB; previous supported versions; duplicate attempt; crash mid-transaction; checksum mismatch; older binary after migration; actor move during migration; source/sink mismatch; resnapshot after a retention gap. Test generated SQL with the actual hosted engine, not just SQLite's syntax parser.

## Sources and evidence

- [E09: Effect SQL client](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/sql/SqlClient.ts) — Transaction and reserved-connection API reference; bind each database role independently.
- [Q02: SQLite transaction model](https://www.sqlite.org/lang_transaction.html) — Write transaction and locking semantics; supports analysis of local receipts/fence checks.
- [T03: Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/reference) — Inspect transactions, client disposal, protocol, and limitations for selected endpoint.
