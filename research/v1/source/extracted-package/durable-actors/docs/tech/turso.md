# Turso/libSQL — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Hosted actor-private relational database fleet.

## Alternatives
Self-host libSQL, D1, Neon, mvSQLite/FDB, own VFS. Select managed libSQL pilot conditionally.

## Selection rationale
Avoid storage-engine work while keeping arbitrary actor-local SQL.

## Maturity
Differentiate libSQL production endpoint from newer Turso engine rewrite.

## Performance
Benchmark provision/open/tx/migrations/count limits and remote hops.

## Developer experience
Database-per-actor is intuitive; fleet management should stay behind the runtime.

## Effect integration
Existing @effect/sql-libsql path depends on @libsql/client.

## Bun integration
Test remote client behavior and native local test variants under Bun.

## Node compatibility
Run same driver/resource tests under Node.

## CI behavior
Disposable DB fixtures with strict cost/creation caps; never expose provider token to fork PR.

## Local behavior
Local file/libSQL provides a fast adapter but not full managed feature parity.

## Production behavior
Conditional on transaction/trigger/fencing/primary-read/restore contract.

## Maintenance risk
Provider engine/API transitions and pricing/quota changes are material.

## Licensing
Managed terms and libSQL open-source license are different obligations.

## Pricing
Model database count, read/write/index amplification, storage, backups and plan minimums.

## Lock-in
Provider provisioning/replication/backup APIs are coupling even when SQL is familiar.

## Migration path
Export/import rehearsals and preserved catalog/incarnation metadata.

## Known issues / uncertainties
Do not assume new architecture works through old libSQL protocol; quotas may block fine granularity.

## Operational burden
We still manage catalog, credentials, migrations, deletion and recovery integration.

## Security implications
Per-DB credentials, TLS, controlled egress and metadata isolation.

## Sources
- [libSQL versus Turso Database](https://docs.turso.tech/libsql)
- [Turso pricing](https://turso.tech/pricing.md)
- [Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/reference)
- [Turso Platform API](https://docs.turso.tech/api-reference/introduction)
- [libSQL repository](https://github.com/tursodatabase/libsql)
- [Effect libSQL package](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/sql/libsql/package.json)
