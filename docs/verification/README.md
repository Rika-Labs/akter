# Verification

**Responsibility:** index the verification documents and their evidence requirements.  
**Authority:** evidence.  
**Owner role:** verification/reliability.  
**Change policy:** new guarantees require a test or an explicit unsupported result.

The v4 evidence surface is `ActorTest` from `@durable-actors/core/testing`, with `describeConformance` running the same guarantees against PGlite, real Postgres, and Neki. Fast tests MAY use PGlite; database locks, pooling, runner movement, and Neki behavior require their real targets.

- [Failure matrix](02-failure-matrix.md)
- [Performance and capacity](03-performance.md)
- [Named invariants](invariants.md)

A capability MUST NOT be called supported until its contract invariant, failure rows, relevant §4 gate, and backend cases pass or the documentation marks it unsupported.
