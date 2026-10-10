# Verification

[Backend removal](neki-removal.md) records the Postgres/PGlite-only runtime, transactional inspection-view retirement and retained generic ownership mechanisms. [Explicit unrouted Neki](neki-unrouted.md) is historical evidence for a removed backend, not a current test or support claim.

The cross-database coordination regression suite is `packages/akter/src/runtime/database/coordination.test.ts`, included in the Postgres integration project. It creates two actor-data databases and one shared authority, proves retention/workflow contention and rollback/release, terminates the authority backend to test the local data fence, and exercises Cluster session/table locks, singleton lease reads, fleet lock release, and actor-scoped capped-job locking ([ADR 0066](../decisions/0066-authoritative-coordination.md)). It does not certify a hosted provider or database failover topology.

**Responsibility:** index the verification documents and their evidence requirements.  
**Authority:** evidence.  
**Owner role:** verification/reliability.  
**Change policy:** new guarantees require a test or an explicit unsupported result.

The v4 app-testing surface is `ActorTest` from `@rikalabs/akter/testing`. The unpublished `@akter/conformance` workspace in `tooling/conformance` runs `describeConformance` against PGlite and a real Postgres database; it also owns cluster/simulation harnesses and crash fixtures. Fast tests MAY use PGlite; database locks, pooling and runner movement require real Postgres. [Package evidence](framework-package.md) records the boundary and dependency upgrade checks.

Joined inspection views are checked by `tooling/conformance/src/conformance/inspection-views.ts` on PGlite and Postgres: rows, tenant isolation, structural read-only behavior, the 14-entry catalog and schema-only readers. `runtime/database/pglite.test.ts` checks that no retired `_v2` variant remains. Inspector and operator suites read the original joined views. The migration test refuses retirement when an external dependency exists, verifies rollback, then retries and restarts without changing actor rows.

Startup migration evidence lives in `runtime/database/migrations.test.ts`: six concurrent `Actors.layer` builds and six independent processes on fresh Postgres data/coordination databases, migration history and Cluster-table creation, and a 0032-to-0033 upgrade with rollback and restart. Existing transaction/schema and subprocess recovery suites cover interruption and rollback without a provider DDL journal. The public socket startup drill in `tooling/conformance/src/conformance/crash/drills/production.test.ts` uses local Postgres and real subprocesses; its nine scenarios passed in the [removal verification](neki-removal.md). Docker-based failover drills remain separate evidence.

- [Failure matrix](02-failure-matrix.md)
- [Pipeline performance: repeated local timings, retained coverage and failure controls](pipeline-performance.md)
- [Docs appearance and font loading: local Mintlify evidence and provider limits](docs-appearance.md)
- [Cold tier: owner-side fetch, guarded garbage, Postgres crashes and S3-compatible evidence](cold-tier.md)
- [Low-connection Postgres: four-session floor and wait-cycle evidence](low-connection-postgres.md)
- [Performance and capacity](../../BENCHMARKS.md)
- [Named invariants](invariants.md)
- Served-command flight accounting: the Postgres pipeline case counts every pool and independently derives seven statements/two flights for a warm dirty-state command and five statements/two flights for a warm replay. Admission cases reject a caller-supplied redelivery flag and an expired result whose receipt committed while its handler was paused; the same result-expiry check runs on PGlite ([ADR 0072](../decisions/0072-served-command-in-two-round-trips.md)).

`bun run test:node` runs the core real-Postgres conformance shards on Node 24+ and a clean packed-tarball PGlite quickstart, including two processes that observe persisted increments. Configure `TEST_DATABASE_URL` and, for replica cases, `TEST_REPLICA_DATABASE_URL`. `check:ci` runs this evidence and the Bun tarball smoke without changing the Verify workflow. Provider-specific and subprocess crash evidence remain separate; a Node core pass does not establish Node crash-drill or provider support.

A capability MUST NOT be called supported until its contract invariant, failure rows, relevant §4 gate, and backend cases pass or the documentation marks it unsupported.

CLI distribution evidence lives in `.github/src/pack.ts` and `.github/src/release/smoke.ts`. The pack check rejects missing bin/export targets, leaked TypeScript sources, undeclared imports, unresolved workspace dependencies, and versions that differ from the framework. The clean-consumer smoke installs both tarballs and checks the public command tree, offline login help, and a scaffolded counter application's readiness route and inspector asset through `akter dev` on Node and Bun. Focused CLI tests reject a wrong hosted API default, broken override precedence, and use of the old implicit operator-token variable.
