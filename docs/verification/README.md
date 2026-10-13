# Verification

Current evidence concerns the 0.2 bucket engine. A recorded 0.1 observation, a simulator pass and a local MinIO pass are not interchangeable with production-provider evidence.

- [Named invariants](invariants.md) and [failure matrix](02-failure-matrix.md)
- [E1: contracts, synchronous execution, deduplication and seeded simulation](e1-execution.md)
- [E2: fencing, checkpoints, replay and bounded drain](e2-recovery.md)
- [E3: bucket membership, mTLS routing, sends, timers and measured handoff limits](e3-cluster.md)
- [E4: the one RPC group, sessions, Effect client and serving](e4-rpc-serve.md)
- [E5: jobs, workflow journals, retries and durable sleep](e5-jobs.md)
- [E6: page trees, bounded cache, history, actor forks and lease-fenced GC](e6-pages-history.md)
- [E7: persisted owner indexes, audited operators, local dev and telemetry](e7-find-operators.md)
- [Store protocol](store-protocol.md) and [provider support matrix](store-providers.md)
- [Framework package boundary](framework-package.md) and [self-host recipe evidence](self-host.md)
- [Public environment API keys](environment-api-keys.md)
- [0.1 retirement map](0.1-retirement.md), [historical invariants](history/2026-10-12-invariants-0.1.md), [historical failure matrix](history/2026-10-12-failure-matrix-0.1.md) and [historical package measurements](history/2026-10-12-framework-package-0.1.md)

Use the repository commands. `bun run test:node:units` runs its named unit/protocol cases; the full framework suite runs separately on Bun and Node. `TEST_S3_URL` selects the local S3-compatible integration endpoint. The bucket protocol and cluster process suites run against MinIO on both runtimes; the CLI storage probe has its own integration suite. Remove only the test containers, volumes and networks you created.

E6's local page, actor-fork and GC evidence is scoped in its report; retained-history boundary repair and production-provider/50 GB gates remain open. General multi-tenant addressing and hosted lifecycle/provider gates remain unverified. The [support matrix](../operations/support-matrix.md) names these limits. A capability is supported only within the scope of its passing invariant, failure-path and backend evidence.
