# @rikalabs/akter

**The framework for durable, stateful backends that power realtime apps, background work, and agents.**

Define each part of your app once: its data, the commands it accepts, the work it schedules, and the clients it updates. The framework keeps all of it consistent, retries what fails, and picks up where it left off.

## Start

```sh
bun add @rikalabs/akter effect @effect/sql-pg @effect/sql-pglite drizzle-orm
```

The runtime needs [Bun](https://bun.sh) 1.4.2 or later, or [Node.js](https://nodejs.org) 24 or later. Provide `BunCrypto` / `BunHttpServer` from `@effect/platform-bun` on Bun, or `NodeCrypto` / `NodeHttpServer` from `@effect/platform-node` on Node. Effect, its SQL drivers, and Drizzle are shared peer dependencies with compatible caret ranges, so your app and the framework use the same peer-provided copy. Keep the generated lockfile; see the [quickstart](https://docs.akter.dev/quickstart) for both runtimes.

## Example

An order that records its lines, emits an event, and charges the customer. The contract is the only file clients import:

```ts title="src/order/contract.ts"
import { Actor } from "@rikalabs/akter"
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

| Import                    | What it holds                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `@rikalabs/akter`         | Browser-safe declarations: `Actor.make`, commands, queries, events, jobs, errors, and handles. |
| `@rikalabs/akter/runtime` | `Actors.layer`, `Actors.serve`, `Auth`, and the database layers.                               |
| `@rikalabs/akter/client`  | The browser-safe Promise client: commands, queries, reducers, feeds, streams, and connections. |
| `@rikalabs/akter/testing` | `ActorTest`, crash and clock controls, and inspection.                                         |

## Learn more

- [Repository](https://github.com/Rika-Labs/akter#readme): what you build with it, how it works, and how it compares.
- [Quickstart](https://github.com/Rika-Labs/akter/blob/main/docs/quickstart.md): create, run, and test an app.
- [Concepts](https://github.com/Rika-Labs/akter/blob/main/docs/guides/concepts.md): actors, commands, receipts, and the work that continues after a commit.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
