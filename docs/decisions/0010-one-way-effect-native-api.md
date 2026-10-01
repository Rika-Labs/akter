# ADR 0010: One way to do everything: the Effect-native actor API

**Status:** accepted design (2026-09-23); a type spike, implementation, and migration of the M0 code remain pending.

**Responsibility:** fix the public API shape so each task has exactly one spelling.

**Authority:** historical decision record.

**Owner role:** API/Effect.

**Change policy:** supersede through a new ADR when the public API changes.

## Context

The M0 code and the v4 ledger expose several ways to do the same thing:

- `Actor.make(name, { commands, internal, queries, ..., lifecycle })` with lists that must agree;
- `X.toLayer(handlers, { hooks, effects, run, shardGroup, spanAttributes })`;
- a `(ctx, input)` parameter plus an untyped global `Turn` service;
- `x.Command(...)` and `x.Command.send(...)`;
- `singleton: true` beside `id`;
- `X.create()`, `X.id`, and `Actors.mint(X)` for minting;
- `{ as }` and `{ tenant }` on `get` beside `Actor.as`.

The owner's rule: **one way to do anything**. A second way exists only when it changes outcomes materially. Definitions should read like Effect's own (`Rpc.make`, `Workflow.make`, `Schema.Struct`): small data objects and Effect values, never code inside configuration.

## Decisions

### `Actor.make` is the only way to make an actor, and it takes one data object

```ts
export const Counter = Actor.make("Counter", {
  key: CounterId,
  state: CounterState,
  events: [CountChanged],
  api: { Increment, Reset, GetCount },
  policy: { hibernateAfter: "30 seconds", cron: { "0 * * * *": Reset } },
})
```

| Section     | Content                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `key`       | an id schema (named), `Actor.singleton`, or omitted (framework-minted UUIDv7)                                             |
| `placement` | `"tenant"` (default), `"actor"`, or a parent actor definition ([ADR 0006](0006-scale-rules-placement-and-query-tiers.md)) |
| `state`     | one `Actor.state(fields, { migrations })`                                                                                 |
| `tables`    | `Actor.table` values                                                                                                      |
| `blobs`     | `Actor.blob` values                                                                                                       |
| `events`    | `Actor.Event` classes                                                                                                     |
| `effects`   | `Actor.effect` classes                                                                                                    |
| `api`       | record of commands, reducers, queries, streams, connections, and workflows; each key equals its tag                       |
| `policy`    | serializable policies only                                                                                                |

Every section is data. Hooks, loops, executors, and placement code live in layers. `Actor.command`, `Actor.reducer`, `Actor.query`, `Actor.stream`, `Actor.connection`, `Actor.workflow`, `Actor.state`, `Actor.table`, `Actor.blob`, `Actor.Event`, and `Actor.effect` make members; they never make actors.

Type checks replace lists that had to agree:

- an `api` key must equal its member's tag;
- `Actor.singleton` and an id schema are one field, so they cannot conflict;
- `policy.cron` and `policy.createdBy` must name a command in `api`, and cron targets must take no input;
- internal commands carry `internal: true` in their own declaration.

`policy` keys replace the lifecycle combinators one for one:

| Policy                | Replaces                               |
| --------------------- | -------------------------------------- |
| `hibernateAfter`      | `Hibernate.after`                      |
| `commandTimeout`      | `Commands.timeout`                     |
| `lockWait`            | `Commands.lockWait`                    |
| `deliveryTimeout`     | `Delivery.timeout`                     |
| `maxStateBytes`       | `State.maxBytes`                       |
| `mailboxCapacity`     | `Mailbox.capacity`                     |
| `createdBy`           | `Lifecycle.createdBy`                  |
| `keepReceipts`        | `Receipts.keep`                        |
| `keepEvents`          | `Events.keep`                          |
| `effectRetry`         | `Effects.retry`                        |
| `connections`         | `Connections.park` / `keepAwake`       |
| `cron`                | `Cron.every`                           |
| `cronSkipIfOlderThan` | `Cron.every(..., { skipIfOlderThan })` |

### Two kinds of state change: commands and reducers

`Actor.command` runs an effectful server handler. `Actor.reducer(tag, { state, input, errors, reduce })` declares a pure transition in the contract. It has no server handler, runs optimistically in the browser, and returns the new state. A reducer with `commutative: { combine }` may be merged across runners, returns `void`, and cannot declare errors. Keeping both kinds changes outcomes materially: only a reducer can run on the client or merge without serialization.

### Handlers take their input; context is a typed service per phase

Every handler is `(input) => Effect`. Context arrives through Effect's requirement channel:

| Service        | Phase                     | Provides                                                                                                                                |
| -------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `X.Turn`       | command handler           | `id`, `ref`, `caller`, `principal`, `commandId`, `isNew`, `state`, `rows`, `group`, `blob`, `emit`, `perform`, `broadcast`, `terminate` |
| `X.Read`       | query and stream handlers | `id`, `ref`, `caller`, `principal`, committed `state`, read-only `rows`/`group`/`blob`, `events`                                        |
| `X.Connection` | connection handler        | `X.Read` plus connection `state`, `resumed`, and `broadcast`                                                                            |
| `X.Workflow`   | workflow body             | owner `id`, `principal`, `executionId`, `key`, and owner-event `waitFor`                                                                |
| `X.Executor`   | effect executor           | `effectId`, `attempt`, `principal`, owner `ref`                                                                                         |

A helper's type states where it may run: `Effect<void, E, Chat.Turn>` compiles only inside a Chat command. The `ctx` parameter, the untyped global `Turn`, `vars`, `StateSnapshot`, `ctx.db`, and `ctx.now` are removed:

- `vars` becomes a `Ref` in the layer's build closure.
- `ctx.db` becomes `group`: a Drizzle client scoped to the actor's placement group ([ADR 0006](0006-scale-rules-placement-and-query-tiers.md)).
- `ctx.now` becomes `DateTime.now`, and the runtime pins the clock per turn.
- Workflow activities and durable sleep use Effect's own `Activity` and `DurableClock`.

### Layers: three kinds, Effect form only, no options object

```ts
export const ChatLive = Chat.toLayer(
  Effect.gen(function* () {
    const typing = yield* Ref.make(new Set<string>())
    yield* Effect.addFinalizer(() => Effect.logInfo("room sleeping"))
    yield* Chat.onDefect((cause) => Effect.logError("defect", cause))
    return { SendMessage, MarkDelivered, EffectDeadLettered }
  }),
)
export const ChatReads = Chat.toQueryLayer(Effect.succeed({ Recent }))
export const ChatEffects = Chat.toEffectLayer(Effect.succeed({ SendEmail }))
```

The three layers stay separate because they run in different phases and can run on different processes. Each old option or hook moves to one place:

| Old              | New                                                                            |
| ---------------- | ------------------------------------------------------------------------------ |
| `onWake`         | the build body                                                                 |
| `onSleep`        | `Effect.addFinalizer`                                                          |
| `run`            | `Effect.forkScoped` in a singleton's build                                     |
| `onCreate`       | `turn.isNew`                                                                   |
| `onDefect`       | `X.onDefect(f)` registered in the build body                                   |
| `onEffectFailed` | an internal `EffectDeadLettered` command                                       |
| `effects`        | `X.toEffectLayer`                                                              |
| `shardGroup`     | runtime placement ([ADR 0011](0011-direct-commands-outbox-and-performance.md)) |
| `spanAttributes` | `Effect.annotateLogs` and `Effect.annotateCurrentSpan`                         |

`X.of` survives only if the type spike shows handlers need it for contextual typing.

### Calling: request/reply outside a turn, intents inside

```ts
const counter = yield * Counter.get(id) // named; Counter.get() for a singleton, Counter.create() to mint
const state = yield * counter.Increment(5) // request/reply

const later = yield * Counter.intents(id) // only inside a turn
yield * later.Increment(1) // commits with the turn, delivered after
yield * later.Reset().pipe(Intent.after("1 hour"), Intent.key("idle"))
yield * Intent.cancel("idle")
```

- **Handles.** The tag, `api` key, handler key, and handle method are the same PascalCase name. `.send` is removed.
- **Request/reply outside a turn.** It works the same from applications, workflows, and effect executors. Executors report results by calling internal commands as the System caller.
- **Intents inside a turn.** `X.intents(id)` requires the runtime's `Actor.InTurn` marker. Calling `X.get` inside a turn keeps the existing "Request/reply inside a turn" type error. Self-intents use `X.intents(turn.id)`.
- **Minting.** `X.create()` is the only way to mint an id. `Actors.mint` and the public `X.id` schema are removed.
- **Caller and tenant.** Caller and tenant are ambient. The edge sets them per request, `ActorTest.layer` per test, and `Actor.as(caller)` and `Actor.tenant(tenant)` around any Effect. `get` takes no options.
- **Command ids.** `Actor.commandId(id)` is the only way to supply an explicit command id.

## Alternatives

- **An array of mixed members, or combinators piped onto `Actor.make`:** rejected. The array was hard to read, and pipes put a second place to shape an actor next to the constructor.
- **Option B, `turn.send(Counter, id, Increment, 1)`:** rejected. It differs from the outside call shape and reads less like Effect.
- **camelCase methods:** rejected. They would add a second spelling of every command name.
- **A `ctx` parameter:** rejected. It duplicates the service path and forces helpers to thread it through.
- **Per-command durability levels:** rejected by [ADR 0011](0011-direct-commands-outbox-and-performance.md).

## Consequences and evidence

The implemented M0 code in `packages/akter` and `examples/*` still uses the earlier spelling described in [ADR 0007](0007-foundation-command-protocol.md) and [ADR 0008](0008-foundation-completion.md). Migrating it is M1 work, and no conformance evidence changes until then. The [API documents](../api/README.md) now describe this target shape.

This ADR supersedes these v4 decisions:

- 3 (separate member arrays);
- 11, 109, and 159 (hooks and `toLayer` options);
- 51 (`vars` spelling);
- 124 (the `(ctx, input)` order);
- 157 (`singleton: true` and `Cron.every` as a lifecycle policy);
- 171 (the `Members` bag);
- the `get` options from 8, 89, and 154.

It also supersedes the `Actor.make` option list and `toLayer(handlers, { hooks })` in ADR 0008.

The type spike in `research/v5` must prove, with `@ts-expect-error` cases:

- handler inference from the `api` record;
- rejection of a mismatched `api` key;
- rejection of an unknown or non-zero-input `cron` target;
- phase errors: `turn.emit` in a query, and `X.intents` outside a turn;
- the request/reply-in-turn error;
- recorded typecheck time.

## Revisit when

- The spike shows `api` record inference is too slow or too weak for clear errors.
- A use case needs a second spelling that changes outcomes materially.
