<div align="center">

# durable-actors

_An Effect-native actor framework with durable identity, transactional turns, and ordinary relational data. One database per deployment, not per actor._

[![Status](https://img.shields.io/badge/status-M0--foundation-blue)](docs/milestones/M0-foundation.md) [![Effect](https://img.shields.io/badge/Effect-4.0.0--rc.116-blue)](https://effect.website) [![Bun](https://img.shields.io/badge/Bun-1.4.2-black)](https://bun.sh)

</div>

**M0 foundation is complete; the framework is not production-ready.** Embedded actors have typed commands, minted/named/singleton identities, creation and size policies, bounded turns, receipts, rollback, and caller attribution. The shared PGlite/Postgres harness exercises the real runtime; Postgres adds independent-connection and process-kill recovery evidence. The package remains private. Broader actor members, transports, multi-runner operation, and provider support remain gated. See the [implemented subset](docs/api/01-server-api.md#implemented-foundation-subset) and [executable evidence](docs/verification/01-conformance.md#foundation-evidence).

Run the example against a **disposable Postgres database**; startup creates the framework tables:

```sh
DATABASE_URL=postgres://user:password@localhost:5432/counter bun run --filter @durable-actors/counter start
```

Each run commits one increment and retries the same command Effect. `committed` and `replayed` match; restarting the program increments the persisted counter once more. [Runtime wiring](examples/counter/src/main.ts) uses explicit application authorization, not an HTTP authentication endpoint.

## The API

Define an actor, implement its commands, and get a typed handle. Small values live in database-backed state; relational records stay in ordinary tables. There is one way to do each task. The shape below follows [ADR 0010](docs/decisions/0010-one-way-effect-native-api.md). The reducer is target design; the command, state, policy, and `X.Turn` parts run today (see the [implemented subset](docs/api/01-server-api.md#implemented-foundation-subset) and the runnable [counter](examples/counter/src/counter/contract.ts)).

```ts
import { Effect, Result, Schema } from "effect"
import { Actor } from "@durable-actors/core"

export const CounterState = Actor.state({
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

// A reducer is a pure transition: it runs optimistically in the browser and authoritatively on the server.
export const Increment = Actor.reducer("Increment", {
  state: CounterState,
  input: Schema.Int,
  reduce: (state, amount) => Result.succeed({ count: state.count + amount }),
})

export const Reset = Actor.command("Reset")

export const Counter = Actor.make("Counter", {
  state: CounterState,
  api: { Increment, Reset },
  policy: { hibernateAfter: "30 seconds" },
})

export const CounterLive = Counter.toLayer(
  Effect.succeed({
    Reset: Effect.fn(function* () {
      const turn = yield* Counter.Turn
      yield* turn.state.set({ count: 0 })
    }),
  }),
)

const program = Effect.gen(function* () {
  const counter = yield* Counter.create()
  return yield* counter.Increment(1)
})
```

Omit `key` for a framework-minted ID and `Counter.create()`. Use an ID schema for `Counter.get(id)`, or `key: Actor.singleton` for `Counter.get()`. Outside a turn every call is request/reply; inside a turn, `Counter.intents(id)` records durable intents that commit with the turn. Acquiring a handle writes nothing; the first command establishes durable state.

In an application, the contract and `CounterLive` belong in separate `contract.ts` and `layer.ts` files. The application supplies the handler layer and `Actors.layer` from `@durable-actors/core/runtime`. See the [server API](docs/api/01-server-api.md) for the full design.

## Why Effect for actors?

An actor framework has to coordinate state, ownership, retries, resources, and failures. Effect supplies the building blocks; Durable Actors adds the actor-specific contracts around them.

- **Typed contracts:** schemas define inputs, outputs, events, and declared errors. Handles preserve the error channel instead of reducing every failure to an untyped exception.
- **Dependency injection:** actor handlers compose through services and layers; database and transport wiring stay at the application boundary.
- **Structured concurrency:** activations own their resources. A fiber forked in an actor's layer starts on wake and is interrupted on sleep, rather than becoming an orphaned background task.
- **Durable execution:** Cluster, SQL, Workflow, Clock, and Deferred primitives underpin placement, turns, activities, timers, and waits; the framework does not introduce a second runtime beside Effect.
- **Faithful testing:** the intended `ActorTest` uses real turns, SQL storage, and serialization with controlled time and injected faults—not a fake context that bypasses the transaction.

These are design requirements. The [verification gates](docs/verification/01-conformance.md#design-verification-gates) determine when each can be claimed as implemented.

## Core Concepts

One constructor, `Actor.make`, with one definition object. Its sections define the actor's behavior:

- **Commands, reducers, and queries:** commands run serialized in short transactions and are delivered directly; reducers are pure transitions that also run optimistically on the client; queries read committed rows from the nearest caught-up replica without waking the actor.
- **State, tables, and blobs:** compressed keyed state, actor-owned Drizzle tables, and database-backed binary chunks share the turn boundary. Activation-local values in a layer are explicitly ephemeral.
- **Events and connections:** durable events replay after a cursor; streams and broadcasts are live. Typed connections can park while the activation sleeps, but transport loss still requires reconnecting.
- **Intents and effects:** turns record work for other actors, timers, and external providers in one actor-shard outbox. Delivery follows commit; external effects remain at least once unless a provider proves stronger guarantees.
- **Workflows and schedules:** workflows are members of their owning actor. `policy.cron` schedules commands; `key: Actor.singleton` expresses cluster-wide ownership without another actor constructor.

The framework has no AI-specific toolkit or MCP surface. Coding agents are applications built from these same primitives; external tools can consume the planned OpenAPI surface.

## The model

One relational database per deployment region, with tenants inside it. Actors own mutation, not a private database or exclusive visibility over every row.

```text
command → generation fence → receipt lookup → handler → commit
                                                       ↓
                                          reply, delivery, observation
```

The turn commits its state, owned rows, database blobs, events, intents, effects, and receipt together. A lease or an in-memory activation cannot authorize a write on its own; the database fence must validate it.

Handlers do not hold that transaction open while waiting for another actor, a socket, a timer, or an external API. They record an intent instead. See [command turns](docs/contracts/02-command-turns.md) and [context capabilities](docs/api/02-context.md).

## What happens when…

**…the process dies after commit but before replying?** The caller retries with the same command ID. The retained receipt returns the original result without running the handler again. Reusing the ID with different input is a conflict.

**…the actor hibernates?** Committed state and future work remain in the database; activation-local values and resources disappear. Parking can preserve a socket while its transport stays alive, not after the process holding that socket dies.

**…an external provider's response is lost?** A missing response is not proof of failure. The application needs provider idempotency or reconciliation before an unsafe retry; an actor receipt does not make an arbitrary external effect exactly once.

**…the process dies before commit?** Nothing was durable. The caller's handle retries with the same command ID and the command executes once. Work that must survive the caller is recorded as an intent or a workflow.

**…the backend is Neki?** Every intent is written to an outbox on the sending actor's shard and delivered after commit, so no write needs a cross-shard transaction. Neki locking, pinning, and outbox recovery remain provider-specific verification gates.

The command/receipt recovery subset has completed fault tests; hibernation, providers, and Neki remain design contracts.

## One package, four entries

| Entry                          | Responsibility                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `@durable-actors/core`         | Actor contracts, members, policies, identity, errors, handles, and served composition. |
| `@durable-actors/core/runtime` | `Actors.layer`, database integration, topology, migrations, and runtime internals.     |
| `@durable-actors/core/client`  | A browser-safe Promise client derived from the same contracts, not a second runtime.   |
| `@durable-actors/core/testing` | `ActorTest`, fault controls, inspection, and backend conformance.                      |

The same design targets **embedded** use inside an Effect application, **served** use through `Actor.serve`, and **hosted** operation behind managed ingress. Only the embedded Postgres foundation subset is implemented. Serving is optional; embedded callers do not need an HTTP hop.

## Documentation

- [Start here](docs/README.md) — the design and documentation authority order.
- [Public API](docs/api/README.md) — declarations, contexts, clients, and Drizzle integration.
- [Runtime contracts](docs/contracts/README.md) — transactions, ownership, receipts, recovery, and security.
- [Architecture](docs/architecture/README.md) — topology, storage, dispatch, and repository layout.
- [Verification](docs/verification/README.md) — invariants, failure cases, and evidence required for support.
- [Milestones](docs/milestones/README.md) — implementation scope and sequencing.

The [research archive](research/README.md) preserves the exploration and type-level sketches. `docs/` is the implementation-facing source of truth when older proposals disagree.

## Dev

Use [Bun](https://bun.sh) **1.4.2**. Effect and its adapters are pinned to **4.0.0-rc.116**; install the lockfile rather than independently upgrading the runtime packages.

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs repository structure validation, formatting, lint, typechecks, tests, and builds. These checks validate the current monorepo; passing them does not establish an actor runtime that has not been implemented.

Database integration checks use `bun run check:ci` with an explicitly configured disposable Postgres instance through `TEST_DATABASE_URL`; never point that variable at a production database. See [CI and verification](.github/ci.md). If installation or compiler patching fails on a different Bun version, use the pinned version and retry the frozen install rather than editing dependency versions.

## Status

Durable Actors is in design and foundation work, before a usable framework release. The public shape is agreed, but runtime behavior, PGlite compatibility, Neki support, and hosted deployment still need implementation and evidence. Feedback is welcome; a documented API is not yet a production guarantee.
