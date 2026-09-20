# V1 scope

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Ship in the first usable alpha

- Immutable actor definition plus implementation Layer.
- Effect RPC-based typed commands/queries with explicit durable submission receipts.
- Fenced actor-local database turns and dedupe outcomes.
- PostgreSQL delivery bridge and recoverable outbox discovery.
- Turso/libSQL adapter after remote capability tests, plus local test adapter.
- Activation/passivation and code/schema compatibility checks.
- One-shot durable delayed messages.
- Retained events with cursor replay and one HTTP/SSE example.
- Minimal inspect/status tooling and a clear self-host deployment.

## Conditional beta increments

Add Effect Workflow bridge after dedicated conformance proof. Add a single-table -> customer PostgreSQL projection connector after snapshot/replay/backpressure tests. Expose the attractive projected descriptor only when the pipeline behind it is real. BlobStore can be a standard external capability once object/reference consistency is specified.

## Not V1

Agent framework; arbitrary workflow DSL; multi-source incremental SQL compiler; automatic ProjectionActor fleet; custom SQLite VFS/storage engine; global multi-region migration; broad untrusted multi-tenant hosting; every cloud/cache/provider; queue/topic/cache/lock specializations; a complete custom ORM; SLA claims; unlimited identity/storage pricing.

## Definition of alpha done

A reference application demonstrates restart recovery, duplicate submission, current owner enforcement, migration compatibility, replayable observation and an actionable inspect view on both supported runtimes. No silent unsupported mode claims durability. Installation and examples work from packed packages, not only a workspace checkout.

## Sources and evidence

- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
- [T03: Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/reference) — Inspect transactions, client disposal, protocol, and limitations for selected endpoint.
