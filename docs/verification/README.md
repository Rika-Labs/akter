# Verification

The cross-database coordination regression suite is `packages/akter/src/runtime/database/coordination.test.ts`, included in the Postgres integration project. It creates two actor-data databases and one shared authority, proves retention/workflow contention and rollback/release, terminates the authority backend to test the local data fence, and exercises Cluster session/table locks, singleton lease reads, fleet lock release, and shard-local capped-job locking. It does not prove Neki advisory routing or multi-shard provider failover; those remain gated by #66 ([ADR 0066](../decisions/0066-authoritative-coordination.md)).

**Responsibility:** index the verification documents and their evidence requirements.  
**Authority:** evidence.  
**Owner role:** verification/reliability.  
**Change policy:** new guarantees require a test or an explicit unsupported result.

The v4 evidence surface is `ActorTest` from `@rikalabs/akter/testing`, with `describeConformance` running the same guarantees against PGlite, real Postgres, and Neki. Fast tests MAY use PGlite; database locks, pooling, runner movement, and Neki behavior require their real targets.

- [Failure matrix](02-failure-matrix.md)
- [Performance and capacity](../../BENCHMARKS.md)
- [Named invariants](invariants.md)

A capability MUST NOT be called supported until its contract invariant, failure rows, relevant §4 gate, and backend cases pass or the documentation marks it unsupported.
