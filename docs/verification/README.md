# Verification

The cross-database coordination regression suite is `packages/akter/src/runtime/database/coordination.test.ts`, included in the Postgres integration project. It creates two actor-data databases and one shared authority, proves retention/workflow contention and rollback/release, terminates the authority backend to test the local data fence, and exercises Cluster session/table locks, singleton lease reads, fleet lock release, and shard-local capped-job locking. It does not prove Neki advisory routing or multi-shard provider failover; those remain gated by #66 ([ADR 0066](../decisions/0066-authoritative-coordination.md)).

**Responsibility:** index the verification documents and their evidence requirements.  
**Authority:** evidence.  
**Owner role:** verification/reliability.  
**Change policy:** new guarantees require a test or an explicit unsupported result.

The v4 evidence surface is `ActorTest` from `@rikalabs/akter/testing`, with `describeConformance` running the same guarantees against PGlite, a real Postgres database, and Neki. Fast tests MAY use PGlite; database locks, pooling, runner movement, and Neki behavior require their real targets.

Single-table inspection views ([ADR 0095](../decisions/0095-single-table-inspection-views.md)) are checked by `testing/conformance/inspection-views.ts`, which runs every case once per view set on PGlite and Postgres (rows, tenant isolation, no write by any owner, catalog, schema-only reader), by `runtime/database/pglite.test.ts` (no joined view where a topology routes the actor tables, both sets elsewhere), and by the inspector and operator suites, which read only the `_v2` views. Provider-specific routed layouts and multi-shard evidence remain outside the OSS launch claim.

Startup migration protocol evidence lives in `runtime/database/neki/migrations.test.ts`: real-Postgres SIGKILL at each durable DDL/progress boundary, migration 0025-to-0026 upgrades with existing data, a waiting startup contender after owner death, and six concurrent `Actors.layer` builds on a fresh database. Its local propagation stand-in is not router evidence. The same three protocol scenarios are gated by `TEST_NEKI_DATABASE_URL`, require a dedicated empty database, and are skipped without the variable; run that file separately from other Neki workloads. [ADR 0070](../decisions/0070-neki-startup-migrations.md) records the remaining provider gates.

- [Failure matrix](02-failure-matrix.md)
- [Performance and capacity](../../BENCHMARKS.md)
- [Named invariants](invariants.md)
- Served-command flight accounting: the Postgres pipeline case counts every pool and independently derives seven statements/two flights for a warm dirty-state command and five statements/two flights for a warm replay. Admission cases reject a caller-supplied redelivery flag and an expired result whose receipt committed while its handler was paused; the same result-expiry check runs on PGlite ([ADR 0072](../decisions/0072-served-command-in-two-round-trips.md)).

`bun run test:node` runs the core real-Postgres conformance shards on Node 24+ and a clean packed-tarball PGlite quickstart, including two processes that observe persisted increments. Configure `TEST_DATABASE_URL` and, for replica cases, `TEST_REPLICA_DATABASE_URL`. `check:ci` runs this evidence and the Bun tarball smoke without changing the Verify workflow. Provider-specific and subprocess crash evidence remain separate; a Node core pass does not establish Node crash-drill or provider support.

A capability MUST NOT be called supported until its contract invariant, failure rows, relevant §4 gate, and backend cases pass or the documentation marks it unsupported.

CLI distribution evidence lives in `.github/src/pack.ts` and `.github/src/release/smoke.ts`. The pack check rejects missing bin/export targets, leaked TypeScript sources, undeclared imports, unresolved workspace dependencies, and versions that differ from the framework. The clean-consumer smoke installs both tarballs and checks the public command tree, offline login help, and a scaffolded counter application's readiness route and inspector asset through `akter dev` on Node and Bun. Focused CLI tests reject a wrong hosted API default, broken override precedence, and use of the old implicit operator-token variable.
