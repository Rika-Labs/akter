# Self-hosted product

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Promise

Self-hosters get the same public actor model and protocol semantics as the standard managed deployment when they use a tested backend configuration. They own infrastructure availability, updates, backup/recovery and credentials. The framework must not require a managed-cloud account merely to execute local/self-hosted actors.

## Minimum planned deployment

Bun or Node runners; PostgreSQL control database; a tested actor-private SQLite/libSQL database provider/server; optional filesystem/S3 BlobStore; memory cache; optional external projection sink. Shared Valkey, dashboards and dedicated event buses are not mandatory just to demonstrate correctness.

A local file-per-actor adapter is useful for development but requires storage placement/recovery planning for multi-host production. A self-hosted libSQL server is not automatically a horizontally elastic millions-of-databases platform. Document its supported fleet size and operations based on tests rather than extending Turso Cloud marketing to it.

## Distribution

Publish container images and an example Compose topology after the runtime exists. Initial Compose in this archive provisions only development PostgreSQL; it does not claim to run a working actor system. Later add separate runner/gateway/relay commands with health/readiness and versioned config. Kubernetes packaging should follow demonstrated demand rather than precede a working single-region deployment.

## Required runbook

Provisioning catalog backup; actor DB export; credential rotation; controlled drain/upgrade; incompatible migration recovery; projection outage/backlog management; leaked resource cleanup; command receipt inspection; dead-letter retry; disk/storage quotas; deletion workflow. Every destructive command needs an explicit environment and backup/recovery warning.

## Support boundary

Maintain a tested matrix of runtime versions, PostgreSQL versions, libSQL endpoints and storage capabilities. Unsupported custom adapters may compile but do not inherit the standard guarantee label. Publish a conformance suite so community adapters can earn support through evidence.

## Sources and evidence

- [T05: libSQL repository](https://github.com/tursodatabase/libsql) — Self-hosted engine/server source; not a promise of Cloud feature or economics parity.
- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [E03: SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts) — Reserved/rebuildable PostgreSQL connection and advisory lock behavior; assess current hardening, not an old issue headline.
- [D03: Railway configuration](https://docs.railway.com/reference/config-as-code) — Config schema for deployment scaffold.
