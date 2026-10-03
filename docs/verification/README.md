# Verification

**Responsibility:** index the verification documents and their evidence requirements.  
**Authority:** evidence.  
**Owner role:** verification/reliability.  
**Change policy:** new guarantees require a test or an explicit unsupported result.

The v4 evidence surface is `ActorTest` from `@rikalabs/akter/testing`, with `describeConformance` running the same guarantees against PGlite, real Postgres, and Neki. Fast tests MAY use PGlite; database locks, pooling, runner movement, and Neki behavior require their real targets.

- [Failure matrix](02-failure-matrix.md)
- [Performance and capacity](../../BENCHMARKS.md)
- [Named invariants](invariants.md)

`bun run test:node` runs the core real-Postgres conformance shards on Node 24+ and a clean packed-tarball PGlite quickstart, including two processes that observe persisted increments. Configure `TEST_DATABASE_URL` and, for replica cases, `TEST_REPLICA_DATABASE_URL`. `check:ci` runs this evidence and the Bun tarball smoke without changing the Verify workflow. Provider-specific and subprocess crash evidence remain separate; a Node core pass does not establish Node crash-drill or provider support.

A capability MUST NOT be called supported until its contract invariant, failure rows, relevant §4 gate, and backend cases pass or the documentation marks it unsupported.
