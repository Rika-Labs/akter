# Verification

**Responsibility:** index the verification documents and their evidence requirements.  
**Authority:** evidence.  
**Owner role:** verification/reliability.  
**Change policy:** new guarantees require a test or an explicit unsupported result.

The v4 evidence surface is `ActorTest` from `@rikalabs/akter/testing`, with `describeConformance` running the same guarantees against PGlite, real Postgres, and Neki. Fast tests MAY use PGlite; database locks, pooling, runner movement, and Neki behavior require their real targets.

Startup migration protocol evidence lives in `runtime/database/neki/migrations.test.ts`: real-Postgres SIGKILL at each durable DDL/progress boundary, migration 0025-to-0026 upgrades with existing data, a waiting startup contender after owner death, and six concurrent `Actors.layer` builds on a fresh database. Its local propagation stand-in is not router evidence. The same three protocol scenarios are gated by `TEST_NEKI_DATABASE_URL`, require a dedicated empty database, and are skipped without the variable; run that file separately from other Neki workloads. [ADR 0070](../decisions/0070-neki-startup-migrations.md) records the remaining provider gates.

- [Failure matrix](02-failure-matrix.md)
- [Performance and capacity](../../BENCHMARKS.md)
- [Named invariants](invariants.md)

A capability MUST NOT be called supported until its contract invariant, failure rows, relevant §4 gate, and backend cases pass or the documentation marks it unsupported.
