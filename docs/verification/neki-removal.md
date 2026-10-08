# Postgres/PGlite-only backend verification

Recorded on 2026-10-08 for [ADR 0112](../decisions/0112-postgres-and-pglite-only.md), rebased onto the merged [framework package split](framework-package.md). This is local runtime and package evidence, not a hosted-provider or production-upgrade certification.

## Removal and retained behavior

The runtime has no Neki backend option, topology directory, shard-targeted sessions/pools, `__neki` transaction settings, substitute commit version, DDL propagation barrier or autocommit migration journal. Its provider fixtures, conformance tests and separate CI migration project are deleted. The already merged cloud API contract reports database source and state rather than an engine selector; its schema test rejects the old `neki` engine status. The rebase preserves that contract and its tests unchanged.

Relative to the [merged framework package split](https://github.com/Rika-Labs/akter/commit/a1bb6612), `git diff --numstat a1bb6612 -- packages/akter/src tooling/conformance/src packages/cloud-api/src` records 4,735 source lines removed and 1,013 added: **3,722 net source lines removed**, including tests. This excludes documentation, workflow/configuration edits and the earlier relocation of the conformance corpus.

Generic mechanisms remain because their consumers and invariants do not require Neki:

- `routing_key` and placement encoding preserve ownership-prefixed keys, parent groups and existing data identities.
- Signed buckets, static range scans and shared claim capacity preserve bounded scheduling, range-boundary isolation and holder liveness on the same database. They select no physical database shard.
- Authority placement keeps bucket -128 and transactional tenant-to-authority conversion for existing application declarations and rows. It is logical grouping, not authorization or physical placement.
- Independent coordination pools, resource rows, local data write fences and Cluster/fleet ownership remain useful with ordinary Postgres. Loss of the authority connection must not release the local write fence.

## Durable transition evidence

Applied migration bodies through `0032` are unchanged. The helpers around them now select ordinary transactional behavior. New `0033_joined_inspection` drops all 15 single-table `_v2` views and restores the original 14-entry joined-view catalog. It preserves the original views, columns, versions and grants and uses no `CASCADE`.

The migration suite rejects these plausible wrong implementations:

- Coordinating only after history-table creation: six concurrent fresh `Actors.layer` builds must start successfully and produce the independently enumerated migration ledger.
- Using only an in-process mutex or omitting coordination/Cluster bootstrap locks: six independent processes on fresh data and coordination databases must start with complete history and Cluster tables.
- Cascading external SQL dependencies or recording a partially applied retirement: a dependent external view must block `0033`, preserving all 15 variants, the 29-entry old catalog, migration history and an actor at generation 17. Removing that dependency and retrying must yield no variants, the 14-entry catalog and the same actor, also after restart.

Existing Postgres coordination, bucket-range, placement, generation, RLS, workflow, relay and subprocess crash suites remain the evidence for their generic guarantees. Five joined-inspection scenarios run on both backends and check committed rows, rollback visibility, tenant isolation, structural read-only behavior and schema-only readers. The focused PGlite database suite additionally checks zero retired variants and the 14-entry catalog after rollback/retry.

Stop all previous alpha runners and migrate external SQL tooling before upgrading. This evidence does not establish mixed-alpha rolling compatibility, conversion of a Neki database, or a production restore; follow the [alpha upgrade procedure](../operations/alpha-upgrades.md).

## Executed checks

Environment: Bun 1.4.2, Node 26.10.0, Vitest 5.0.3 and a disposable Postgres 18.6 server with logical WAL. Postgres commands use `TEST_DATABASE_URL` for that server and unset `TEST_REPLICA_DATABASE_URL`; unit and PGlite commands run without either variable.

| Command                                                                                                            | Decisive result                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`                                                                                                | Nine workspace tasks and CI source checks passed.                                                                                                                                                         |
| `bun run lint`                                                                                                     | Ten tasks passed, including directives and structure; no warnings or errors.                                                                                                                              |
| `bun run test`                                                                                                     | Nine workspace tasks passed; framework 315 tests passed, conformance 628 passed and 245 capability-gated skips. Eight tasks reused matching cached results.                                               |
| `bun run --cwd tooling/conformance test:integration:postgres`                                                      | 51 files passed; 914 tests passed, 18 streaming-replica gates skipped. Includes all six framework migration tests and real-Postgres subprocess recovery.                                                  |
| `bun run --cwd tooling/conformance test:pglite`                                                                    | 22 files passed, three capability-gated files skipped; 587 tests passed, 244 unsupported-capability skips.                                                                                                |
| `bun run --cwd tooling/conformance test:integration:postgres --project=postgres:conformance -t 'inspection views'` | All five affected joined-view cases passed after removing the variant-specific fixture abstraction.                                                                                                       |
| `bun run --cwd tooling/conformance test:pglite --project=pglite:conformance -t 'inspection views'`                 | The same five cases passed on PGlite; unrelated cases were filtered out.                                                                                                                                  |
| `bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/runtime/database/pglite.test.ts`                  | All 11 database cases passed with the new view/catalog assertions.                                                                                                                                        |
| `bun run --cwd tooling/conformance test:integration:drills -t 'public production runner topology'`                 | Nine public-runner scenarios passed over real Postgres and loopback TCP, including independent process startup, SIGKILL, clean handoff and cron recovery. Twelve unrelated drill cases were filtered out. |
| `bun run check:pack`                                                                                               | Pack validation and clean consumer smoke passed on Node and Bun: consumer typecheck, persistent restart, receipt/fault assertions and CLI help/dev/inspector asset checks.                                |
| `bun run format:check`                                                                                             | Repository formatting passed.                                                                                                                                                                             |

Initial full-suite runs found explicit migration-ledger expectations ending at 32; those tests were updated to include 33 and the full Postgres, PGlite and unit suites rerun. Those failed attempts are not counted as passes.

After the full suites, the view-retirement test was strengthened to close its migration pool and build a fresh public `Actors.layer` before checking the preserved actor and catalog. A focused rerun with `test:integration:postgres --project=integration -t 'migrations with Postgres'` passed all six migration tests. The final static check passed formatting, directives, structure, CI typecheck and four verification/release-version tests; final workspace typecheck and lint passed again.

## Package measurement and limits

`bun .github/src/pack.ts --out <temporary-framework-directory> --cli-out <temporary-cli-directory>` followed by `npm pack --dry-run --json --ignore-scripts <temporary-framework-directory>` produces **2,423,564 unpacked bytes, 403 files and 619,281 compressed bytes**. The split-only baseline was 2,494,508 bytes and 411 files; the combined reduction from the original package is 4,052,611 bytes (62.6%) and 212 files. Packed Effect and SQL-driver peers remain `^4.0.2`, accepting the newest patch in the requested cohort; platform-node-shared remains an exact 4.0.2 runtime dependency.

No streaming replica was configured. Docker/network-proxy failover drills, separate-host/provider tests, a production backup/restore rehearsal and the full `check:ci` were not run. The nine production-runner cases above use ordinary local Postgres and subprocesses, not Docker-based failover fixtures. Skips and filtered cases are missing evidence, not passes. No merge, release, publication or production database write is part of this work.
