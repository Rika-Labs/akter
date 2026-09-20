# Turso diligence and acceptance plan

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Decision

Use a tested **libSQL-compatible** Turso deployment for the first hosted actor-database pilot. The driver path is Effect SQL -> @effect/sql-libsql -> @libsql/client -> compatible remote endpoint. Do not conflate that path with every capability of the newer Turso Database Rust rewrite. The inspected libSQL package and Turso documentation distinguish these systems.

## Why it fits

Database-per-entity hosting avoids building a custom SQLite VFS/page store. It lets the framework focus on identity, ownership, command recovery and application schema. Each actor can use local relational tables while the managed provider owns storage service operations.

## Why it may be wrong

Database-count quotas, create/delete rates, migration fleet size, transaction round trips and physical row-write amplification can dominate cost. The newest advertised storage engine may not match the libSQL driver/features required by the framework. A managed provider client does not ensure storage-side actor fencing or cross-store coordination.

## Required vendor questions

Which engine/endpoint is supported under the proposed contract? Are SQLite triggers, JSON functions, transactional DDL, interactive transactions and consistent snapshots supported identically? What are transaction duration/size limits, busy/retry semantics, primary read-after-write behavior and failure behavior after a lost commit response? Can credentials be scoped per DB and rotated without losing recovery access? What are DB-count, provisioning-rate and API quotas? What storage/write/index/replication operations are billed? What are region, backup, PITR, export and deletion guarantees?

## Acceptance tests

Create same database concurrently; retry an ambiguous create; install migrations twice; interrupt migration; mutate with trigger capture; rollback application+receipt; lose commit ACK; verify stale-fence rejection; export/restore with new incarnation; primary read-after-write; deletion and token revocation; scaled idle-client cleanup. Capture exact provider plan/engine version and response codes.

## Commercial view

The pricing page inspected during research listed Free, Developer, Scaler, Pro and Enterprise options, with monthly headline prices around $0, $5.99, $29, $499 and custom respectively. Included database counts and read/write/storage allowances matter as much as the headline. Do not reuse earlier conversation estimates as a contractual cost model. The archive's economic assumptions are labelled hypothetical and must be replaced with an actual quote.

## Exit path

Maintain SQL migrations within a tested SQLite/libSQL subset, data export/import tooling, explicit actor catalog mappings and provider-neutral request IDs. Self-hosted libSQL is a possible fallback but shifts operations to us/customer and does not automatically reproduce Turso Cloud's infrastructure. Switching to PostgreSQL is a product/database migration, not a free Layer swap.

## Sources and evidence

- [T01: libSQL versus Turso Database](https://docs.turso.tech/libsql) — The maintained SQLite fork and newer Rust rewrite are different engine/driver compatibility targets.
- [T02: Turso pricing](https://turso.tech/pricing.md) — Observed plan labels Free/Developer/Scaler/Pro/Enterprise, monthly $0/$5.99/$29/$499/custom; rates and limits must be timestamped.
- [T03: Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/reference) — Inspect transactions, client disposal, protocol, and limitations for selected endpoint.
- [T04: Turso Platform API](https://docs.turso.tech/api-reference/introduction) — Provisioning/control API is separate from SQL data-plane client.
- [T05: libSQL repository](https://github.com/tursodatabase/libsql) — Self-hosted engine/server source; not a promise of Cloud feature or economics parity.
- [E07: Effect libSQL package](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/sql/libsql/package.json) — Inspected rc.115 package depends on @libsql/client ^0.18.0.
