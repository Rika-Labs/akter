# Programming model

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Three things developers define

A protocol states the commands/queries and their input, success and error schemas. An actor description gives that protocol a stable type name and database definition. A Layer supplies its implementation. Deployment wiring registers implementations and binds the database/cluster/runtime capabilities.

```ts
// Proposed Durable Actors API; not exported by this scaffold.
const Todo = Actor.make("Todo", {
  protocol: TodoProtocol,
  database: TodoDatabase,
})

const TodoLive = Todo.toLayer({
  Rename: Effect.fn("Todo.Rename")(function* ({ title }) {
    const repo = yield* TodoRepo
    return yield* repo.rename(title)
  }),
})
```

Do not confuse this design sample with verified Effect syntax for `Entity.toLayer`: the Cluster source currently passes handler inputs with a `payload` field. The adapter must make one deliberate public convention and test it rather than mixing examples.

## What counts as an actor

An order, project, domain or device often has a natural long-lived consistency boundary. Its child rows and local invariants can live in one private relational database. A health check, formatter, stateless search endpoint or password hash normally remains an Effect service/function.

Do not make every route or every row an actor. One actor per todo is an illustrative teaching case, not an economic recommendation for a high-volume CRUD product. Compare database provisioning limits, per-DB metadata and throughput against an actor per workspace/board. The smallest independently consistent entity is a candidate boundary, not a mandatory prescription.

## Read and write paths

Commands go through the authoritative actor. A direct single-entity query can use the same protocol. Fleet-wide joins go to the application's projection database. Read actors are justified when the derived view needs its own state, subscriptions or lifecycle—not merely to avoid a plain query function.

## Domain modules

```
orders/
  schema.ts       # durable domain values
  protocol.ts     # public contracts, no implementation imports
  definition.ts   # actor type + protocol + database descriptor
  repo.ts         # actor-local persistence
  service.ts      # domain calculations / external capability contracts
  actor.ts        # lifecycle/command implementation
```

The HTTP adapter maps domain errors to status codes. Actor-to-actor clients import the public protocol/definition only. A payment provider service does not become an actor unless it has independently owned identity/state; provider calls execute through recoverable work.

## What the environment means

`Database` is actor-scoped and turn-bound where a transaction is open. `Actors` addresses typed peers subject to authorization. `Events` records committed history. `Scheduler` and `Activities` stage durable intentions. `BlobStore`, `Secrets` and `Cache` are standard capabilities with different consistency/lifetime guarantees, not additional private infrastructure instances.

## Sources and evidence

- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [O01: OpenCode service conventions](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/opencode/AGENTS.md) — Flat modules, small Interface, Context.Service, layer/defaultLayer, named Effect.fn, scoped workspace state. Application conventions are not actor semantics.
- [E09: Effect SQL client](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/sql/SqlClient.ts) — Transaction and reserved-connection API reference; bind each database role independently.
