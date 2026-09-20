# Public API design

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Adopt the definition/implementation split

Use a small immutable actor description, typed protocol and separate implementation Layer. Do not encode deployment choices in every actor. Do not require a `StandardActor` preset. A normal description is valid when constructed; optional pure descriptor transforms remain pipeable.

```ts
// Proposed framework API. This code is a design example, not a runnable export.
const Todo = Actor.make("Todo", {
  protocol: TodoProtocol,
  database: TodoDatabase,
})
const TodoLive = Todo.toLayer(Effect.gen(function* () {
  const repo = yield* TodoRepo
  return {
    Rename: ({ title }) => repo.rename(title),
    Get: () => repo.current,
  }
}))
```

`toLayer` is evaluated per actor activation for activation-local services. It is not one process-wide repository capturing whichever actor DB was first opened. Handler Effects use a turn-scoped transaction service, not an ambient global mutable current-actor variable.

## Keep protocol vocabulary close to Effect RPC

The implementation should accept/compile an Effect `RpcGroup`, with one deliberate command/query annotation rather than a duplicate Schema/RPC world. Durable command requests are marked persisted by the adapter. Read-only immediate queries may use a separately documented volatile path; do not silently use that path for mutations.

Use normal module imports from `effect`, `effect/unstable/rpc`, and `effect/unstable/sql`. Our package exports only semantics it adds: actor addresses, durable submissions, receipts, transaction capabilities and projection descriptors.

## Address, submit, observe

Proposed normal surface:

```ts
const actors = yield* Actors
const todo = yield* actors.get(Todo, "todo-123")
const accepted = yield* todo.submit("Rename", { title: "Ship" }, {
  idempotencyKey: "browser-operation-78",
})
const result = yield* accepted.await
```

A convenience `request` can submit and await. A `send` convenience can return only the durable acceptance receipt. Do not use `send(): Effect<void>` if the caller has no way to recover a timed-out submission. Prefer a stable receipt token. The exact `request(Request.make(...))` versus named method client syntax is a type-spike decision; avoid publishing both as equally canonical.

`events({ after })` returns an Effect Stream backed by a retained journal. `broadcast` is a distinct best-effort transport. A plain `stop()` is too ambiguous: distinguish passivate, cancel submission, suspend actor and delete actor.

## State and database

`Database` is a standard per-actor service backed by Effect SQL. Keep basic structured state as a convenience table. `Database.table` is a descriptor for supported column codecs, constraints and projection metadata—not a promise that arbitrary Effect Schema values automatically become SQL DDL. Avoid a second general ORM/query builder in V1.

`Database.projected()` marks an eligible table; it does not silently create a customer database or grant outbound access. Deployment binds an explicit named sink. SQL helpers use parameterized values and validated generated identifiers.

## Limits and escape hatches

No arbitrary Promise callbacks in durable metadata. Persist named protocol routes plus encoded payloads, not closures. Do not expose unrestricted remote calls inside a mutable actor transaction. Start a workflow or issue an outgoing durable intent and resume on a completion command.

Public generics should carry protocol/result/requirements information, not every implementation knob. Typecheck a representative application with 50 protocols before finalizing the API. Add negative type tests for missing handlers, wrong payloads, unhandled errors and unavailable services.

## Sources and evidence

- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E09: Effect SQL client](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/sql/SqlClient.ts) — Transaction and reserved-connection API reference; bind each database role independently.
- [E11: Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md) — Observed support matrix: @effect/tsgo 0.45.0; TypeScript 7.0.2; Oxlint 1.81/1.82; oxlint-tsgolint 7.0.2001.
