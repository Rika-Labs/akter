# What to reuse from Effect

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

| Piece | Adopt | Boundary to preserve |
|---|---|---|
| Effect / Cause / Exit | typed behavior and error handling | typed errors do not prove idempotency |
| Schema | durable envelope and domain validation | not every Schema has a SQL column mapping |
| Context / Layer | capability contracts and construction | merge does not satisfy sibling dependencies |
| Scope | activation resources | finalizers do not run on kill -9 |
| RPC / RpcGroup | typed protocols and transport | persistence must be explicit |
| Cluster | routing, ownership candidates, persistent delivery | storage-side fencing still requires proof |
| SQL | parameterized access and local transactions | one connection/database boundary |
| Workflow / Activity | named recoverable procedures | checkpointed engine semantics, not arbitrary continuation |
| Stream / PubSub | consumption and live notification | process memory is not retained history |
| HttpApi / CLI | transport surface | domain errors remain transport-neutral |
| OTLP / Metrics | observability | control cardinality and payload leakage |
| TestClock / @effect/vitest | deterministic tests | remote distributed failures need real integration tests |

## Avoid parallel frameworks

Do not reexport Effect wholesale, invent another request schema system without a reason, build another DI registry, or turn every dependency into an `Actor.withFoo` combinator. Use ordinary imports and explicit Layers.

## Correct Layer composition

A consumer Layer must be provided its dependencies. `Layer.mergeAll(A, B)` combines outputs but does not automatically inject A's output into B's requirements. A default bundle may also close over an implementation too early, preventing intended overrides. Test per-actor scoping and dependency graph construction explicitly.

## Process/activation split

Reuse global immutable protocol/Schema values. Build actor-specific DB resources/repositories per activation. Use a turn-scoped transaction capability or dynamic transaction binding rather than capturing one long-lived connection. One service tag can mean an actor-scoped service only when it is provided in the correct nested context.

## API stability

Pin the v4 RC ecosystem as one compatibility group. Unstable imports are acceptable behind package boundaries, but upgrades need source review and type/runtime regression tests. Do not claim ordinary semver protects every experimental module between pre-release builds.

## Sources and evidence

- [E01: Effect v4 package snapshot](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/package.json) — Inspected source snapshot identifies 4.0.0-rc.115. A repository version is not proof that every registry artifact is available.
- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
- [E09: Effect SQL client](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/sql/SqlClient.ts) — Transaction and reserved-connection API reference; bind each database role independently.
- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
- [E11: Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md) — Observed support matrix: @effect/tsgo 0.45.0; TypeScript 7.0.2; Oxlint 1.81/1.82; oxlint-tsgolint 7.0.2001.
