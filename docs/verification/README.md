# Verification

## Local control-plane support

`apps/api` has real-Postgres evidence for email/password verification, organizations/teams/invitations, organization-owned API keys, project/environment metadata, personal preferences and atomic audited mutations. Its OIDC suite uses an actual loopback IdP with signed tokens and rejection paths. `packages/cloud-api` covers the browser-safe console and runtime schemas and typed errors. Deployments, runtime proxying/SSE, environment values, domains, regions, provider integrations, usage and Stripe billing are declared but return `NotImplemented`; real Neki, SES sending, GitHub/Google OAuth, DNS verification and SAML support are not established by local tests.

The cross-database coordination regression suite is `packages/akter/src/runtime/database/coordination.test.ts`, included in the Postgres integration project. It creates two actor-data databases and one shared authority, proves retention/workflow contention and rollback/release, terminates the authority backend to test the local data fence, and exercises Cluster session/table locks, singleton lease reads, fleet lock release, and shard-local capped-job locking. It does not prove Neki advisory routing or multi-shard provider failover; those remain gated by #66 ([ADR 0066](../decisions/0066-authoritative-coordination.md)).

**Responsibility:** index the verification documents and their evidence requirements.  
**Authority:** evidence.  
**Owner role:** verification/reliability.  
**Change policy:** new guarantees require a test or an explicit unsupported result.

The v4 evidence surface is `ActorTest` from `@rikalabs/akter/testing`, with `describeConformance` running the same guarantees against PGlite, real Postgres, and Neki. Fast tests MAY use PGlite; database locks, pooling, runner movement, and Neki behavior require their real targets.

Startup migration protocol evidence lives in `runtime/database/neki/migrations.test.ts`: real-Postgres SIGKILL at each durable DDL/progress boundary, migration 0025-to-0026 upgrades with existing data, a waiting startup contender after owner death, and six concurrent `Actors.layer` builds on a fresh database. Its local propagation stand-in is not router evidence. The same three protocol scenarios are gated by `TEST_NEKI_DATABASE_URL`, require a dedicated empty database, and are skipped without the variable; run that file separately from other Neki workloads. [ADR 0070](../decisions/0070-neki-startup-migrations.md) records the remaining provider gates.

- [Failure matrix](02-failure-matrix.md)
- [Performance and capacity](../../BENCHMARKS.md)
- [Named invariants](invariants.md)
- Served-command flight accounting: the Postgres pipeline case counts every pool and independently derives seven statements/two flights for a warm dirty-state command and five statements/two flights for a warm replay. Admission cases reject a caller-supplied redelivery flag and an expired result whose receipt committed while its handler was paused; the same result-expiry check runs on PGlite ([ADR 0072](../decisions/0072-served-command-in-two-round-trips.md)).
- Control-plane feature flags: `packages/flags/src/evaluation.test.ts` rejects wrong precedence, truthiness defaults, unstable hash vectors, percentage boundary errors and unknown-key fallback. `layer.test.ts` rejects memory-store caching, invalid replacements and targeting disclosure. `postgres.test.ts` rejects lost rules across runtime restart, committed rolled-back/interrupted writes, failed replacements/deletions treated as success, and store outages treated as defaults. Real Postgres is required for the latter; Neki is unverified.

- [Cloud infrastructure](cloud-infrastructure.md)
- [Cloud deployments](cloud-deployments.md)

`bun run test:node` runs the core real-Postgres conformance shards on Node 24+ and a clean packed-tarball PGlite quickstart, including two processes that observe persisted increments. Configure `TEST_DATABASE_URL` and, for replica cases, `TEST_REPLICA_DATABASE_URL`. `check:ci` runs this evidence and the Bun tarball smoke without changing the Verify workflow. Provider-specific and subprocess crash evidence remain separate; a Node core pass does not establish Node crash-drill or provider support.

A capability MUST NOT be called supported until its contract invariant, failure rows, relevant §4 gate, and backend cases pass or the documentation marks it unsupported.
