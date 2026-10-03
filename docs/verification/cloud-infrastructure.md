# Cloud infrastructure verification

**Responsibility:** distinguish local infrastructure evidence from provider deployment support.
**Authority:** evidence requirements.
**Owner role:** platform reliability.

The `infra` workspace is checked by repository typecheck, lint, structure, formatting, and its unit tests. `plan:offline` compiles declarations with registered providers for dev/staging/prod in us-east-1/us-west-2. It does not run Alchemy's planner, query live resources, or apply them.

Local evidence rejects malformed or shared stage accounts, missing providers, missing service declarations, and incorrect signed routing-key range boundaries. Bucket tests must cover the extreme signed values, zero, negative-one, and both sides of every shard boundary. These algebraic checks do not establish PlanetScale's interpretation of the topology or Neki SQL semantics.

Before claiming deployed support, run authorized tests with real, stage-scoped credentials:

1. Create staging in each region from empty service state, verify actual account/organization identity, and inspect the VPC routes, private task ENIs, ARM64 platform, ECR images, and all healthy target groups. An account mismatch must fail before any infrastructure mutation.
2. Verify the NLB rejects non-Cloudflare sources, strict TLS succeeds through all three hostnames, customer-domain validation completes, the SaaS SNI rewrite routes to edge, and origin-rule ownership does not cross deployment zones.
3. Verify SES DKIM and configuration-set delivery, KMS data-key generation/decryption, task secret injection, and OTLP delivery into the separate Axiom datasets. Assert error notifications reach the configured destination.
4. Create a Neki database, verify the actual topology, shards, authoritative control group, routers, and role connections. Retry after interruption and out-of-band deletion; reconciliation must converge without losing existing credentials or recreating data destructively.
5. Exercise authorized topology changes through Neki's provider workflow and prove cutover, restart, and rollback behavior before claiming resharding support. Run the existing Neki SQL conformance cases, including fencing, rollback, denied fanout, recovery, and outbox ranges.
6. Destroy staging, confirm provider resources are removed as intended, and confirm retained state and zone remain. Repeat from retained state. Check production retention separately without destructive tests on real customer data.

None of those live-provider gates are established by local checks or by an Alchemy plan. Existing Neki support remains unverified until its provider-specific evidence passes.
