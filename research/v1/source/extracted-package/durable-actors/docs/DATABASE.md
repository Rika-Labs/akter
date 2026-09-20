# Actor-local database model

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Chosen product model

Every activated actor has an isolated relational namespace/database. Turso via a verified libSQL endpoint is the preferred hosted implementation. It is not a separate paid server process per actor. Provisioning, storage limits, idle cost, credentials and database count still depend on the provider plan; the framework cannot promise unlimited databases independently of that contract.

The application uses Effect SQL through `Database`. A local development implementation can use a SQLite/libSQL file. That validates SQL and migrations, not remote failover or durability. Bun's local SQLite API is behind a platform Layer; it is not a cloud storage system.

## Internal tables

Reserve a namespace such as `_da_`:

- `_da_owner`: actor incarnation and current installed fencing epoch.
- `_da_commands`: deduplicated encoded command outcomes and payload digests.
- `_da_outbox`: durable outgoing intentions and relay tracking.
- `_da_events`: retained semantic events and replay position.
- `_da_changes`: projected table changes with before/after keys.
- `_da_migrations`: immutable migration IDs/checksums and applied versions.

These can share one database with application tables so one transaction can commit them together. Reserved names are a framework contract, not by themselves a security boundary. An arbitrary SQL client with the same credentials can alter internal tables. Initially application code is trusted; untrusted hosted code requires a mediated DB capability/authorizer or separate execution boundary. Do not advertise impossible SQL permissions.

## Table declarations without inventing an ORM

The preferred `Database.table(...).pipe(Database.projected())` shape can be retained as metadata above Effect SQL. V1 supports explicit storage codecs: text, signed integer within a documented range, finite real, boolean encoded as integer, bytes, and validated JSON text. Dates need an explicit encoding (UTC text or epoch integer). Nullable and optional columns are different. IDs/defaults/constraints/indexes are declared, not inferred from arbitrary transforms.

Complex Schema refinements may validate application input without being enforceable as SQLite constraints. Generated DDL must record this difference. Reject unsupported codecs with an actionable error. Keep raw SQL migrations as an escape hatch and require projection metadata updates alongside table changes.

## Transactions and repositories

All mutating handlers run within a fenced local turn. Repository queries use the same transaction connection. They must not call `commit`, open an independent client, or fork untracked writes. Expensive remote work is staged, not awaited under the transaction.

Authoritative reads use a primary/session guarantee supported by the driver. Embedded replicas and stale reads are opt-in non-authoritative paths. Do not mix read-after-write examples from a local file with a remote eventual replica.

## Lifecycle

Creation is idempotent: catalog reservation -> provider create/resolve -> schema compatibility check -> fence installation -> migrations -> ready. Persist each provisioning step, retry with the same provider identity, and clean up orphaned DBs using an audited reconciler. Names derived from user input must be canonicalized/hashed with collision handling; an actor ID is not used as a provider database name unchecked.

Deletion is a workflow: reject new commands, drain or cancel tracked work, export/retain data if required, tombstone identity, notify projections, revoke DB credentials, then delete after a configured grace period. Restoration creates a new database incarnation and reconciles message receipts and projections rather than replaying old high watermarks blindly.

## Performance and cost gates

Benchmark cold provision, warm open, one transaction, N indexed writes, migrations, export/import, rollback after connection loss and thousands of concurrent DB clients. Do not open an unbounded pool per actor; most remote clients should be scoped lightweight handles with bounded global concurrency. Database counts and request-rate limits are product capacity constraints as important as storage GB.

## Sources and evidence

- [T01: libSQL versus Turso Database](https://docs.turso.tech/libsql) — The maintained SQLite fork and newer Rust rewrite are different engine/driver compatibility targets.
- [T02: Turso pricing](https://turso.tech/pricing.md) — Observed plan labels Free/Developer/Scaler/Pro/Enterprise, monthly $0/$5.99/$29/$499/custom; rates and limits must be timestamped.
- [T03: Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/reference) — Inspect transactions, client disposal, protocol, and limitations for selected endpoint.
- [T04: Turso Platform API](https://docs.turso.tech/api-reference/introduction) — Provisioning/control API is separate from SQL data-plane client.
- [E07: Effect libSQL package](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/sql/libsql/package.json) — Inspected rc.115 package depends on @libsql/client ^0.18.0.
- [E09: Effect SQL client](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/sql/SqlClient.ts) — Transaction and reserved-connection API reference; bind each database role independently.
- [B07: Bun SQLite](https://bun.com/docs/runtime/sqlite) — Local runtime-specific database, not a remote durable fleet backend.
- [Q01: SQLite triggers](https://www.sqlite.org/lang_createtrigger.html) — Transactional row-trigger mechanism; OLD/NEW semantics; test compatibility with target engine.
- [Q02: SQLite transaction model](https://www.sqlite.org/lang_transaction.html) — Write transaction and locking semantics; supports analysis of local receipts/fence checks.
