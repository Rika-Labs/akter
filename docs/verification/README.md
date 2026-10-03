# Verification

## Local control-plane support

`apps/api` has real-Postgres evidence for email/password verification, organizations/teams/invitations, organization-owned API keys, project/environment metadata, personal preferences and atomic audited mutations. Its OIDC suite uses an actual loopback IdP with signed tokens and rejection paths. `packages/cloud-api` covers browser-safe console/runtime/billing schemas and typed errors. Deployments, runtime proxying/SSE, environment values, domains, regions and nonbilling provider integrations remain declared `NotImplemented` surfaces.

Billing and usage now have implemented local service boundaries and actor-backed transitions. `packages/billing` exercises Distilled requests through fake HTTP and the SQL-backed local provider; `packages/metering` exercises receipt/read journaling, rollback, replay, retention, sealing and ownership on real Postgres. Billing and metering actor tests exercise provider-outcome loss, event/import deduplication, atomic projections and ambiguous export quarantine. The collector and billing HTTP suites exercise their actual local provider and database paths. These are local correctness gates, not live Stripe or Neki support. Fractional Stripe meter acceptance, asynchronous validation/error reports, real checkout/tax/payment flows, customer authentication in the portal, provider webhook delivery and Neki multi-shard/shared-schema accounting remain unverified until authorized provider evidence exists.

Review regressions reject catalog/config drift, a plan update that skips immediate invoicing, reuse of an expired checkout's cached identity, clearing an ambiguous checkout fence without proof, invoking the unused framework hook, rescanning a persisted storage sample, using a stale admission cap after a concurrent update, and charging a watch denied by the connection cap. The edge-to-runner regressions use the real runtime and journal rather than a successful-response stub. Fake Stripe requests remain wire-contract evidence only; payment-gated metered-price changes and usage retained during pending updates require real Stripe sandbox verification.

The cross-database coordination regression suite is `packages/akter/src/runtime/database/coordination.test.ts`, included in the Postgres integration project. It creates two actor-data databases and one shared authority, proves retention/workflow contention and rollback/release, terminates the authority backend to test the local data fence, and exercises Cluster session/table locks, singleton lease reads, fleet lock release, and shard-local capped-job locking. It does not prove Neki advisory routing or multi-shard provider failover; those remain gated by #66 ([ADR 0066](../decisions/0066-authoritative-coordination.md)).

**Responsibility:** index the verification documents and their evidence requirements.  
**Authority:** evidence.  
**Owner role:** verification/reliability.  
**Change policy:** new guarantees require a test or an explicit unsupported result.

The v4 evidence surface is `ActorTest` from `@rikalabs/akter/testing`, with `describeConformance` running the same guarantees against PGlite, real Postgres, and Neki. Fast tests MAY use PGlite; database locks, pooling, runner movement, and Neki behavior require their real targets.

- [Failure matrix](02-failure-matrix.md)
- [Performance and capacity](../../BENCHMARKS.md)
- [Named invariants](invariants.md)
- Control-plane feature flags: `packages/flags/src/evaluation.test.ts` rejects wrong precedence, truthiness defaults, unstable hash vectors, percentage boundary errors and unknown-key fallback. `layer.test.ts` rejects memory-store caching, invalid replacements and targeting disclosure. `postgres.test.ts` rejects lost rules across runtime restart, committed rolled-back/interrupted writes, failed replacements/deletions treated as success, and store outages treated as defaults. Real Postgres is required for the latter; Neki is unverified.

- [Cloud infrastructure](cloud-infrastructure.md)

A capability MUST NOT be called supported until its contract invariant, failure rows, relevant §4 gate, and backend cases pass or the documentation marks it unsupported.
