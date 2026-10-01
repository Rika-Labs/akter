# @durable-actors/core

**The framework for durable, stateful backends that power realtime apps, background work, and agents.**

Define each part of your app once: its data, the commands it accepts, the work it schedules, and the clients it updates. The framework keeps all of it consistent, retries what fails, and picks up where it left off.

## Start

Create an app that runs on an embedded Postgres, with nothing else to install:

```sh
bun create @durable-actors my-app
```

Or add the framework to an existing app:

```sh
bun add @durable-actors/core@alpha effect@4.0.0 @effect/sql-pg@4.0.0 @effect/sql-pglite@4.0.0 drizzle-orm@1.0.0-rc.5-5935859
```

The runtime needs [Bun](https://bun.sh) 1.4.2 or later. Effect, its SQL drivers, and Drizzle are peer dependencies pinned to the versions the framework is tested with, so your app and the framework share one copy of each.

## Example

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

Implement its commands. Each handler runs inside its command's transaction:

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

`Place` inserts the lines, emits `OrderPlaced`, records the total, and enqueues `Charge` in one commit. The charge runs after the commit and reports back as `Charged`, and a retry of `Place` with the same command ID returns the stored total instead of placing the order again.

## Entry points

| Import                         | What it holds                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `@durable-actors/core`         | Browser-safe declarations: `Actor.make`, commands, queries, events, jobs, errors, and handles. |
| `@durable-actors/core/runtime` | `Actors.layer`, `Actors.serve`, `Auth`, and the database layers.                               |
| `@durable-actors/core/client`  | The browser-safe Promise client: commands, queries, reducers, feeds, streams, and connections. |
| `@durable-actors/core/testing` | `ActorTest`, crash and clock controls, and inspection.                                         |

## Learn more

- [Repository](https://github.com/Rika-Labs/durable-actors#readme): what you build with it, how it works, and how it compares.
- [Quickstart](https://github.com/Rika-Labs/durable-actors/blob/main/docs/quickstart.md): create, run, and test an app.
- [Concepts](https://github.com/Rika-Labs/durable-actors/blob/main/docs/guides/concepts.md): actors, commands, receipts, and the work that continues after a commit.

## Status

This is an alpha. APIs and storage formats can change between releases, and each database runs one runtime process for now. [CHANGELOG.md](CHANGELOG.md) lists what each release contains.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
