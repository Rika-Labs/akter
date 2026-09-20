# Interface inventory and contracts

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Stable boundary candidates

| Boundary | Responsibility | Not responsible for |
|---|---|---|
| ActorAddress | app/environment/type/id/incarnation identity | authorization by string alone |
| ActorDefinition | protocol, database descriptor, compatible code/schema versions | opening connections |
| Actors | resolve refs, submit and recover typed outcomes | importing another domain repo |
| Database | actor-local Effect SQL and transactional reads/writes | cross-DB atomic transactions |
| Turn | fence, receipt, staged intentions and local commit | arbitrary durable JavaScript continuation |
| DatabaseProvisioner | resolve/create scoped DB using idempotent catalog entries | deciding business schema |
| OutboxRelay | transfer committed intents, checkpoints, retries | pretending remote delivery is atomic with source |
| Scheduler | named delayed durable messages and cancellation revisions | serializing arbitrary Schedule functions |
| WorkBridge | durable workflow launch and completion routing | exactly-once external provider actions |
| Events | schema-versioned journal and replay cursors | global total order |
| ProjectionSink | validated ordered change application and checkpoints | owning authoritative domain state |
| BlobStore | actor-namespaced immutable object writes/reads | rollback with SQLite |
| Secrets | read authorized redacted secret values | caller-selected cross-tenant lookup |

## Type-only sketch

```ts
interface ActorAddress {
  readonly application: string
  readonly environment: string
  readonly actorType: string
  readonly actorId: string
  readonly incarnation: string
}
interface CommandIdentity {
  readonly commandId: string
  readonly payloadDigest: string
  readonly protocolVersion: number
}
interface CommitReceipt {
  readonly commandId: string
  readonly actorRevision: string // decimal integer on JSON boundary
  readonly outcome: "succeeded" | "rejected"
}
interface ChangePosition {
  readonly incarnation: string
  readonly sequence: string
  readonly ordinal: number
}
```

These structures are specification sketches. Brand IDs with Schema at actual encoded boundaries. Do not erase tenant/application identity into an actorId string prefix and rely on formatting for security.

## Execution context rules

A service Layer that depends on a specific actor DB is acquired inside that activation Scope. Its DB operations resolve the turn transaction dynamically when used in a handler, or the repository itself is turn-scoped. A process-global `Layer.memoMap` cannot safely cache one actor-specific Database for all actors.

The generic database backend interface must include a tested transaction contract. Separate providers may implement it only after conformance tests pass. It is not sufficient to satisfy a TypeScript method signature.

## Core service naming

Use `const db = yield* Database` as requested. Internally files may use `Interface`, `Service` and `layer` names following OpenCode's pattern, with explicit public aliases at package boundaries. Standardize one exported name per capability; do not force callers to choose between `Database`, `Database.Service` and `ActorDatabase`.

Keep platform and protocol metadata names explicit: `ControlSql`, `ActorSql`, `ProjectionSql`. Two generic `SqlClient` services provided at the same graph level can shadow one another. Construct named Layers and bind the generic client only inside the consuming service's scope.

## Compatibility discipline

A public addition needs encoding behavior, migration behavior, error semantics, cancellation behavior, validation cases and an inspect/debug representation. Until these are specified, keep it in a design document rather than a published stable method.

## Sources and evidence

- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E09: Effect SQL client](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/sql/SqlClient.ts) — Transaction and reserved-connection API reference; bind each database role independently.
- [O01: OpenCode service conventions](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/opencode/AGENTS.md) — Flat modules, small Interface, Context.Service, layer/defaultLayer, named Effect.fn, scoped workspace state. Application conventions are not actor semantics.
