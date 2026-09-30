<div align="center">

# durable-actors

_An Effect-native actor framework with durable identity, transactional turns, and ordinary relational data. One database per deployment, not per actor._

[![Status](https://img.shields.io/badge/status-alpha-blue)](docs/milestones/README.md) [![Effect](https://img.shields.io/badge/Effect-4.0.0--rc.116-blue)](https://effect.website) [![Bun](https://img.shields.io/badge/Bun-1.4.2-black)](https://bun.sh)

</div>

**The framework is in alpha and not production-ready.** M0, M2, and M4 are built, M1 is in progress, and M3, M5, and M6 are open ([milestones](docs/milestones/README.md)). Actors have typed commands, reducers, and queries; keyed state, owned tables, and blobs; events, intents, timers, effects, workflows, cron, connections, streams, and cross-actor subscriptions. `Actor.serve` serves them over HTTP, WebSocket, SSE, OpenAPI, and MCP, and `@durable-actors/core/client` is the Promise client. The shared PGlite/Postgres harness exercises the real runtime; Postgres adds independent-connection, multi-runner, and process-kill recovery evidence. The alpha package is `@durable-actors/core`; see [Install](#install). Provider support (Neki) remains gated. See the [implemented subset](docs/api/01-server-api.md#implemented-foundation-subset) and [executable evidence](docs/verification/01-conformance.md#foundation-evidence).

## Quickstart

```sh
bun create @durable-actors my-app   # or: --template chat
cd my-app && bun install
bun start   # visits: 1
bun start   # visits: 2, read back from ./.data
bun test
```

The generated app stores its data in file-backed [PGlite](https://pglite.dev), so it needs no Docker or database server; `DATABASE_URL=postgres://...` switches it to Postgres. PGlite here is for development and one process per data directory, not production. Neither package is on npm before the `0.1.0-alpha` release, so for now the [quickstart](docs/quickstart.md) runs the scaffolder from a checkout against a locally packed tarball.

## Install

> **Alpha, single runner.** `0.1.0-alpha.0` is the first alpha release candidate; follow [the release procedure](docs/operations/05-releasing.md) for its publication status. Run one runtime process per database: multi-runner operation is not supported yet. APIs and stored formats may change between alphas without a migration path, so don't point it at data you need to keep.

The runtime needs [Bun](https://bun.sh) 1.4.2 or later and Postgres (or PGlite for tests). Effect, Drizzle and the Effect SQL drivers are peer dependencies pinned to the exact release candidates the framework is tested against, so install those versions beside it:

```sh
bun add @durable-actors/core@alpha effect@4.0.0-rc.116 @effect/sql-pg@4.0.0-rc.116 @effect/sql-pglite@4.0.0-rc.116 drizzle-orm@1.0.0-rc.5-5935859
```

```ts
import { Actor } from "@durable-actors/core"
import { Actors, Database } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
```

Changes are listed in the [changelog](packages/durable-actors/CHANGELOG.md). The code is licensed under [Apache-2.0](LICENSE).

## The API

Define an actor, implement its commands, and get a typed handle. This is the quickstart's counter, and CI runs it on PGlite and Postgres:

<!-- snippet file=src/counter/contract.ts -->

```ts
// src/counter/contract.ts: the actor's public shape
import { Actor } from "@durable-actors/core"
import { Effect, Schema } from "effect"

export const Increment = Actor.command("Increment", { input: Schema.Int, output: Schema.Int })

export const Counter = Actor.make("Counter", {
  key: Schema.NonEmptyString,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Increment },
})
```

<!-- snippet file=src/counter/layer.ts -->

```ts
// src/counter/layer.ts: the handler runs inside the turn's transaction
import { Effect } from "effect"
import { Counter } from "./contract.ts"

export const CounterLive = Counter.toLayer(
  Effect.succeed({
    Increment: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Counter.Turn
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
  }),
)
```

<!-- snippet file=src/main.ts
import { BunCrypto } from "@effect/platform-bun"
import { Actors, Database } from "@durable-actors/core/runtime"
import { Console, Effect, Layer } from "effect"
import { Counter } from "./counter/contract.ts"
import { CounterLive } from "./counter/layer.ts"
const DatabaseLive = Database.pglite({ dataDir: "./.data" })
-->

```ts
// src/main.ts: runtime wiring and one call
const live = CounterLive.pipe(
  Layer.provideMerge(Actors.layer()),
  Layer.provide(DatabaseLive), // Database.postgres with DATABASE_URL, else Database.pglite({ dataDir })
  Layer.provide(BunCrypto.layer),
)

const program = Effect.gen(function* () {
  const counter = yield* Counter.get("visits")
  const visits = yield* counter.Increment(1)

  yield* Console.log(`visits: ${visits}`)
})
```

Code in your own process runs as the trusted `System` caller in the `"default"` tenant, so it names neither a caller nor a tenant. A served actor is closed to outside callers until it declares who may use it with `access` on `Actor.make`; `Actor.access.public` opens it to anyone, for demos. Acquiring a handle writes nothing; the first command establishes durable state. A retried command with the same command ID replays its receipt instead of running again. The [chat template](packages/create/templates/chat/src/room/contract.ts) adds an owned Drizzle table, events, a reducer, queries, and a declared error, and [`examples/chat`](examples/chat) adds blobs, effects, and retention. [`examples/orders`](examples/orders) places orders inside an app with its own Postgres tables, mints a shipment actor per package, charges through an idempotent effect, and proves with a SIGKILL crash drill that no acknowledged order is lost and no payment is taken twice. What runs today is listed in the [implemented subset](docs/api/01-server-api.md#implemented-foundation-subset); the [server API](docs/api/01-server-api.md) also describes planned members.

## Why Effect for actors?

An actor framework has to coordinate state, ownership, retries, resources, and failures. Effect supplies the building blocks; Durable Actors adds the actor-specific contracts around them.

- **Typed contracts:** schemas define inputs, outputs, events, and declared errors. Handles preserve the error channel instead of reducing every failure to an untyped exception.
- **Dependency injection:** actor handlers compose through services and layers; database and transport wiring stay at the application boundary.
- **Structured concurrency:** activations own their resources. A fiber forked in an actor's layer starts on wake and is interrupted on sleep, rather than becoming an orphaned background task.
- **Durable execution:** Cluster, SQL, Workflow, Clock, and Deferred primitives underpin placement, turns, activities, timers, and waits; the framework does not introduce a second runtime beside Effect.
- **Faithful testing:** `ActorTest` uses real turns, SQL storage, and serialization with controlled time and injected faults—not a fake context that bypasses the transaction.

These are design requirements. The [verification gates](docs/verification/01-conformance.md#design-verification-gates) determine when each can be claimed as implemented.

## Core Concepts

One constructor, `Actor.make`, with one definition object. Its sections define the actor's behavior:

- **Commands, reducers, and queries:** commands run serialized in short transactions and are delivered directly; reducers are pure transitions that also run optimistically on the client; queries read committed rows from the nearest caught-up replica without waking the actor.
- **State, tables, and blobs:** compressed keyed state, actor-owned Drizzle tables, and database-backed binary chunks share the turn boundary. Activation-local values in a layer are explicitly ephemeral.
- **Events and connections:** durable events replay after a cursor; streams and broadcasts are live. Typed connections can park while the activation sleeps, but transport loss still requires reconnecting.
- **Intents and effects:** turns record work for other actors, timers, and external providers in one actor-shard outbox. Delivery follows commit; external effects remain at least once unless a provider proves stronger guarantees.
- **Workflows and schedules:** workflows are members of their owning actor. `policy.cron` schedules commands; `key: Actor.singleton` expresses cluster-wide ownership without another actor constructor.

The framework has no AI-specific toolkit. `Actor.serve` derives OpenAPI and an MCP endpoint from the same definitions as transports, and coding agents are applications built from these same primitives.

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

Crash and runner-loss recovery have fault tests on Postgres ([conformance](docs/verification/01-conformance.md)); Neki remains a provider-specific verification gate.

## One package, four entries

| Entry                          | Responsibility                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `@durable-actors/core`         | Actor contracts, members, policies, identity, errors, handles, `Actor.serve`, and `Actor.auth`. |
| `@durable-actors/core/runtime` | `Actors.layer`, database integration, topology, migrations, and runtime internals.              |
| `@durable-actors/core/client`  | The browser-safe Promise client: commands, queries, reducers, feeds, streams, and connections.  |
| `@durable-actors/core/testing` | `ActorTest`, fault controls, inspection, and backend conformance.                               |

The same design targets **embedded** use inside an Effect application, **served** use through `Actor.serve`, and **hosted** operation behind managed ingress. Embedded and served use are implemented, and hosted runners behind the edge are built (M4.8). Serving is optional; embedded callers do not need an HTTP hop.

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

Durable Actors is in alpha, before a production release. M0, M2, and M4 are built, M1 is in progress, and M3, M5, and M6 are open ([milestones](docs/milestones/README.md)); Neki support and production claims still need provider-specific evidence. Feedback is welcome; a documented API is not yet a production guarantee.
