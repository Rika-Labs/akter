# ADR 0112: Postgres and PGlite are the framework's only backends

**Status:** accepted (2026-10-08).

## Context

Launch scope is ordinary Postgres, with PGlite for embedded use within its documented limits. Neki's topology discovery, targeted sessions, transaction settings, autocommit DDL journal and inspection variants add a second runtime path without a launch requirement. Keeping them as experimental would still distribute and maintain that path.

## Decision

Remove Neki support completely, not merely its support claim. `Database.postgres` has no `neki` option, public Neki context or topology-denial error. Remove live topology/revision reads, physical shard targets and per-shard pools, `__neki` settings, commit-version substitutes, DDL barriers/journaling, provider fixtures, conformance and CI selections. The public cloud environment contract reports only the Postgres engine.

Use ordinary transaction-bound fencing and WAL commit versions on Postgres. Framework migrations coordinate before history-table creation on one reserved session, then apply transactionally. Independent coordination and Cluster bootstrap retain the same startup mutex. PGlite retains its exclusive directory lock and transactional migrations. Application `Database.schemaChange` remains a transaction under its advisory lock.

Retain engine-independent behavior:

- `routing_key`, signed buckets and range scans preserve ownership-prefixed keys, parent grouping, scan boundaries and shared claim capacity; none selects a physical data shard.
- `placement: "authority"` retains its existing bucket -128 encoding and transactional tenant-to-authority row conversion. Existing rows and application declarations depend on this encoding; it promises logical grouping, not physical placement or authorization.
- The independent coordination pool, deployment resource rows and local data write fences still serialize retention, workflow acceptance, Cluster ownership and fleet maintenance across databases.

Do not edit applied migrations. Add `0033_joined_inspection` to drop the 15 single-table `_v2` variants created by `0031` and restore the original joined-view catalog. Keep the original views, columns, versions and grants. Do not cascade external dependencies: a dependent SQL tool must be migrated first, otherwise the migration rolls back. Stop all previous alpha runners before upgrading; their inspector still reads the retired variants. No direct conversion from a Neki database is supported: restore/export to ordinary Postgres and rehearse before adopting this runtime.

## Supersession

Supersedes ADRs 0057, 0070, 0091–0097 and 0110 as backend decisions. Their observations remain historical evidence, not current instructions. The authority-placement encoding and conversion originally introduced by 0097 are explicitly retained here.

Amends the Neki clauses in ADRs 0005, 0006, 0011, 0030, 0034, 0036, 0037, 0038, 0051, 0054–0056, 0066 and 0067, and all other historical Neki support/provider gates. Their generic ownership, messaging, scheduling, coordination, RLS and recovery decisions remain in force. Contracts 01, 05, 06, 07, 09 and 10, the backend architecture and the operational support matrix reflect this scope.

## Risk and evidence

This is an alpha breaking change for Neki users and `_v2` SQL consumers. Postgres/PGlite turn, receipt, job and recovery behavior is unchanged. Durable placement and ownership keys are not rewritten by this removal.

`runtime/database/migrations.test.ts` rejects fresh-start races with six concurrent layers and six independent processes on fresh data/coordination databases; it verifies blocked view retirement rolls back, then retries and restarts with actor rows preserved. Existing coordination, range, placement, RLS, public conformance and SIGKILL tests remain the behavioral evidence. See [removal verification](../verification/neki-removal.md) for executed commands and limits.
