# Verification

**Responsibility:** index the verification documents and their evidence requirements.  
**Authority:** evidence.  
**Owner role:** verification/reliability.  
**Change policy:** new guarantees require a test or an explicit unsupported result.

The v4 evidence surface is `ActorTest` from `@rikalabs/akter/testing`, with `describeConformance` running the same guarantees against PGlite, real Postgres, and Neki. Fast tests MAY use PGlite; database locks, pooling, runner movement, and Neki behavior require their real targets.

- [Failure matrix](02-failure-matrix.md)
- [Performance and capacity](../../BENCHMARKS.md)
- [Named invariants](invariants.md)
- Control-plane feature flags: `packages/flags/src/evaluation.test.ts` rejects wrong precedence, truthiness defaults, unstable hash vectors, percentage boundary errors and unknown-key fallback. `layer.test.ts` rejects memory-store caching, invalid replacements and targeting disclosure. `postgres.test.ts` rejects lost rules across runtime restart, committed rolled-back/interrupted writes, failed replacements/deletions treated as success, and store outages treated as defaults. Real Postgres is required for the latter; Neki is unverified.

A capability MUST NOT be called supported until its contract invariant, failure rows, relevant §4 gate, and backend cases pass or the documentation marks it unsupported.
