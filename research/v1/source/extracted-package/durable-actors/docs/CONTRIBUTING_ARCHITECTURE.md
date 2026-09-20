# Architecture contribution rules

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

- Core contracts depend on Effect, not vendors or host runtimes.
- Protocol modules do not import actor implementations or repositories.
- SQL writes in a mutable turn use the same actor-local transaction connection.
- External work is staged durably, not performed before the local commit.
- PostgreSQL delivery and actor SQLite commit are separate steps with replay/receipts.
- Storage-side fencing is part of the standard contract, not a debug option.
- Projection tables never become authority by accident.
- Schema/version/incarnation changes require migration and replay analysis.
- Scope/Stream/PubSub/Cache are not presented as durable storage.
- Layer.mergeAll does not satisfy sibling requirements; scope-specific services are not globally memoized.
- All required Effect diagnostics are errors; exceptions need narrow documented review.
- Tests mirror src, and failures are proved against independent durable-state oracles.
- New backends need conformance evidence, not just interface compatibility.
- Performance and price claims cite measured workload/cost evidence.

A PR violating one of these rules must either change the architecture through an ADR or be rejected. Do not silently redefine 'durable' to accommodate a convenient implementation.

## Sources and evidence

- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
- [E11: Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md) — Observed support matrix: @effect/tsgo 0.45.0; TypeScript 7.0.2; Oxlint 1.81/1.82; oxlint-tsgolint 7.0.2001.
- [O01: OpenCode service conventions](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/opencode/AGENTS.md) — Flat modules, small Interface, Context.Service, layer/defaultLayer, named Effect.fn, scoped workspace state. Application conventions are not actor semantics.
