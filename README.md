<div align="center">

# Durable Actors

**The framework for durable, stateful backends that power realtime apps, background work, and agents.**

[Quickstart](docs/quickstart.md) · [Concepts](docs/guides/concepts.md) · [API](docs/api/README.md) · [Comparison](docs/guides/comparison.md)

</div>

Define each part of your app once: its data, the commands it accepts, the work it schedules, and the clients it updates. The framework keeps all of it consistent, retries what fails, and picks up where it left off.

## What you build with it

- **Realtime apps.** Chat rooms, shared documents, and live dashboards that store their history, push every change to connected clients, and keep sockets open while idle parts of the app sleep.
- **Background work.** Payments, emails, imports, and billing runs that retry with backoff, run on schedules, and end up in a dead letter you can act on instead of disappearing.
- **Agents.** Sessions that keep their transcript, stream output to the browser, pause for an approval, and resume after a crash or a deploy.

Each of these is an actor: an addressable part of your app, such as one order, one room, or one agent session, that handles one command at a time and owns its data, its background work, and its live connections.

## What it looks like

An order that records its lines, emits an event, and charges the customer. The contract is the only file clients import:

```ts title="src/order/contract.ts"
import { Actor } from "@durable-actors/core"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { Schema } from "effect"

export const orderLines = Actor.table(
  pgTable("order_lines", {
    sku: text("sku").primaryKey(),
    quantity: integer("quantity").notNull(),
    unitPrice: integer("unit_price").notNull(),
  }),
)

export const OrderPlaced = Actor.event("OrderPlaced", { total: Schema.Int })

export class AlreadyPlaced extends Schema.TaggedError<AlreadyPlaced>()("AlreadyPlaced", {}) {}

export const Charge = Actor.job("Charge", {
  payload: { amount: Schema.Int },
  success: Schema.Struct({ chargeId: Schema.String }),
})

export const Place = Actor.command("Place", {
  payload: {
    lines: Schema.Array(
      Schema.Struct({ sku: Schema.String, quantity: Schema.Int, unitPrice: Schema.Int }),
    ),
  },
  success: Schema.Int,
  error: AlreadyPlaced,
})

export const Charged = Actor.command("Charged", { payload: { chargeId: Schema.String } })

export const Order = Actor.make("Order", {
  key: Schema.NonEmptyString,
  state: Actor.state({
    total: Schema.optional(Schema.Int),
    chargeId: Schema.optional(Schema.String),
  }),
  tables: [orderLines],
  events: [OrderPlaced],
  jobs: { Charge: { job: Charge, onSuccess: Charged } },
  api: { Place },
  internal: { Charged },
})
```

The handlers. Each one runs inside its command's transaction:

```ts title="src/order/layer.ts"
import { Effect } from "effect"
import { AlreadyPlaced, Charge, Order, OrderPlaced, orderLines } from "./contract.ts"

export const OrderLive = Order.toLayer({
  Place: Effect.fn(function* ({ lines }) {
    const turn = yield* Order.Turn

    if (turn.state.total !== undefined) return yield* AlreadyPlaced.make({})

    const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)

    yield* turn.rows(orderLines).insert(lines)
    yield* turn.emit(OrderPlaced.make({ total }))
    yield* turn.enqueue(Charge.make({ amount: total }))
    yield* turn.state.set({ total })

    return total
  }),

  Charged: Effect.fn(function* ({ chargeId }) {
    const turn = yield* Order.Turn

    yield* turn.state.set({ chargeId })
  }),
})
```

Calling it from anywhere in your app. The handle is typed from the contract, including the `AlreadyPlaced` failure:

```ts title="src/checkout.ts"
import { Effect } from "effect"
import { Order } from "./order/contract.ts"

export const checkout = Effect.gen(function* () {
  const order = yield* Order.get("o-1")

  return yield* order.Place({ lines: [{ sku: "mug", quantity: 2, unitPrice: 1200 }] })
})
```

`Place` inserts the lines, emits `OrderPlaced`, records the total, and enqueues `Charge` in one commit. The charge runs only after that commit, outside the transaction, and its result comes back to the order as the `Charged` command.

### What happens when…

- **…the process dies before the commit?** Nothing was written: no lines, no event, no charge. The caller retries with the same command ID, and the order is placed once.
- **…it dies after the commit, before the reply?** The retry finds the stored result and returns the same total without running the handler again.
- **…the payment provider times out?** `Charge` retries with backoff under one job ID, which the executor passes to the provider as its idempotency key. When the retries run out, the job lands in a dead letter that an `onDeadLetter` command can turn into order state.
- **…the order sits idle?** It sleeps. Its state and pending work stay in the database, and the next command, timer, or job result wakes it.

## Quickstart

```sh
bun create @durable-actors my-app   # or: --template chat
cd my-app && bun install
bun start   # visits: 1
bun start   # visits: 2, read back from ./.data
bun test    # retry, crash, and restart tests
```

The generated app runs on [PGlite](https://pglite.dev), an embedded Postgres, so there's no Docker or database server to set up. Set `DATABASE_URL=postgres://...` to run the same code on Postgres. The [quickstart](docs/quickstart.md) walks through the generated files.

## What you get

- **One transaction per command.** State, rows, events, files, timers, messages to other actors, and jobs commit together. Handlers never hold the transaction open while waiting on the network; slow or external work is recorded and runs after the commit.
- **Safe retries.** Every command carries an ID. A retry with the same ID returns the stored result, and reusing an ID with different input is rejected.
- **Data you own.** State and rows live in your own Postgres as ordinary Drizzle tables, scoped to their actor and tenant. Report across them with plain SQL.
- **Work that outlives the request.** Jobs with retries and dead letters, timers, cron schedules, and workflows that sleep and wait for events.
- **Realtime.** Event feeds that resume from a cursor, WebSocket connections that stay open while an idle actor sleeps, and live streams for output such as tokens.
- **One definition, every interface.** Typed Effect handles, a browser-safe Promise client with optimistic updates, and, through `Actors.serve`, HTTP, WebSocket, and SSE endpoints, an OpenAPI document, and an MCP endpoint.
- **Tests that crash it.** `ActorTest` runs the real transaction path with virtual time, injected crashes, and deterministic simulation.

## Built on Effect

Durable Actors is written with [Effect](https://effect.website) and uses its Cluster, SQL, and Workflow modules rather than a second runtime beside them. Commands, queries, events, and errors are declared with Schema, so inputs, outputs, and failures stay typed from the handler to the client. Handlers get their dependencies from Layers, a fiber an actor starts is interrupted when it sleeps, and tests advance the clock instead of waiting for it.

## How it works

```text
command ─► fence ─► receipt ─► handler ─► COMMIT ─► reply
                                            │
                    state · rows · events · receipt · outbox
                                            │
                                            ▼
                after commit: deliver messages, fire timers, run jobs
```

Each command checks that this process still owns the actor, looks for a stored receipt for its command ID, runs the handler, and commits. Ownership is checked in the database, so a process that has lost an actor can't commit for it. Everything the handler hands off is written to an outbox in the same commit and delivered afterwards. [Concepts](docs/guides/concepts.md) explains the model, and the [runtime contracts](docs/contracts/README.md) state each guarantee precisely.

## How it compares

- **Cloudflare Durable Objects** have the same one-request-at-a-time model on Cloudflare's platform, with storage attached to each object. Durable Actors keeps data in your Postgres and runs in your own process.
- **Rivet Actors** keep state in memory and save it on an interval. Here a command's reply waits for its transaction to commit, and a retry returns the recorded result.
- **Temporal and Restate** record a function's steps so it can resume after a crash. A Durable Actors command is a short transaction instead, and anything slow becomes a job or workflow owned by the actor.

The [comparison](docs/guides/comparison.md) covers each in detail and says when to choose it instead.

## Install

```sh
bun add @durable-actors/core@alpha effect@4.0.0 @effect/sql-pg@4.0.0 @effect/sql-pglite@4.0.0 drizzle-orm@1.0.0-rc.5-5935859
```

The runtime needs [Bun](https://bun.sh) 1.4.2 or later. Effect, its SQL drivers, and Drizzle are peer dependencies pinned to the versions the framework is tested with, so your app and the framework share one copy of each.

| Import                         | What it holds                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `@durable-actors/core`         | Browser-safe declarations: `Actor.make`, commands, queries, events, jobs, errors, and handles. |
| `@durable-actors/core/runtime` | `Actors.layer`, `Actors.serve`, `Auth`, and the database layers.                               |
| `@durable-actors/core/client`  | The browser-safe Promise client: commands, queries, reducers, feeds, streams, and connections. |
| `@durable-actors/core/testing` | `ActorTest`, crash and clock controls, and inspection.                                         |

## Status

Durable Actors is in alpha. APIs and storage formats can change between releases, and each database runs one runtime process for now. The [support matrix](docs/operations/support-matrix.md) lists what is supported today, and the [changelog](packages/durable-actors/CHANGELOG.md) lists what each release contains.

## Documentation

- [Quickstart](docs/quickstart.md): create, run, and test an app.
- [Concepts](docs/guides/concepts.md): actors, commands, receipts, and the work that continues after a commit.
- [Guides](docs/guides/README.md): Effect inside the transaction, testing, and deploying.
- [API reference](docs/api/README.md): declarations, contexts, the client, Drizzle, and generated clients.
- [Fit and non-fit](docs/product/fit-and-non-fit.md): when Durable Actors is the right tool, and when it isn't.
- [Runtime contracts](docs/contracts/README.md): exactly what each guarantee covers and where it stops.

## Contributing

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs the structure, format, lint, type, test, build, and package checks. Database integration tests need a disposable Postgres in `TEST_DATABASE_URL`; [CI](.github/ci.md) has the details. Design decisions are recorded in [`docs/decisions`](docs/decisions/README.md).

## License

[Apache-2.0](LICENSE), copyright Rika Labs.
