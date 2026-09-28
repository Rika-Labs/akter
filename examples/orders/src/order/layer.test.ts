import { BunCrypto } from "@effect/platform-bun"
import { Actor, ActorError, CommandConflict, User, Actors } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import { Config, Crypto, Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { Pool } from "pg"
import { afterAll, expect, it } from "vitest"
import { OrdersLive } from "../layer.ts"
import { fakeLedger } from "../payments/ledger.ts"
import { Shipment } from "../shipment/contract.ts"
import { Order, OrderAlreadyPlaced, OrderId } from "./contract.ts"

const ledger = fakeLedger()

// The same cases run on PGlite (`test`) and on a fresh Postgres database (`test:integration`).
const database = Effect.gen(function* () {
  if ((yield* Config.String("ORDERS_BACKEND")) === "pglite") return undefined

  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `orders_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  return Redacted.make(base.href)
})

const live = Layer.unwrap(
  Effect.gen(function* () {
    return OrdersLive.pipe(
      Layer.provide(ledger.layer),
      Layer.provideMerge(
        ActorTest.layer({ database: yield* database, as: User.make({ subject: "ada" }) }),
      ),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof live>>) =>
  runtime.runPromise(effect)

const ada = { id: "ada", name: "Ada Lovelace", email: "ada@example.com" }

const kettle = { sku: "kettle", name: "Kettle", quantity: 1, unitPrice: 3900, package: "bulky" }

const mugs = { sku: "mug", name: "Mug", quantity: 2, unitPrice: 1200, package: "small" }

const tea = { sku: "tea", name: "Loose-leaf tea", quantity: 3, unitPrice: 850, package: "small" }

const piano = {
  sku: "piano",
  name: "Grand piano",
  quantity: 1,
  unitPrice: 12_000_000,
  package: "freight",
}

const shipment = (id: string) => Shipment.get(id as Parameters<typeof Shipment.get>[0])

/** Ledger keys first seen after `before`: the effect ids of charges this case performed. */
const newKeys = (before: ReadonlySet<string>) =>
  [...ledger.calls.keys()].filter((key) => !before.has(key))

/**
 * Advances the relay until the order's payment has settled and it has
 * nothing left to send, then returns its summary and its shipments' tracking.
 */
const settled = Effect.fnUntraced(function* (id: string) {
  const test = yield* ActorTest
  const order = yield* Order.get(OrderId.make(id))

  for (let round = 0; round < 60; round++) {
    yield* test.advance("1 second")
    const summary = yield* order.Summary()

    const pending = yield* test.inspect(order.ref)

    if (summary.status !== "awaiting_payment" && pending.outbox === 0 && pending.effects === 0) {
      const tracking = yield* Effect.forEach(summary.shipments, (child) =>
        shipment(child).pipe(Effect.flatMap((handle) => handle.Tracking())),
      )

      // An unknown payment leaves the shipments pending for an operator.
      if (
        summary.status === "payment_unknown" ||
        tracking.every(({ status }) => status !== "pending")
      )
        return { order, summary, tracking }
    }
  }

  return yield* Effect.die(new Error(`Order ${id} did not settle`))
})

it("places an order: owned lines, an event, a minted shipment per package, and one charge", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const before = new Set(ledger.calls.keys())
      const order = yield* Order.get(OrderId.make("o-1"))
      const placed = yield* order.Place({ customer: ada, lines: [kettle, mugs, tea] })

      expect(placed.total).toBe(3900 + 2 * 1200 + 3 * 850)
      expect(placed.shipments).toHaveLength(2)

      const { summary, tracking } = yield* settled("o-1")
      const [key] = newKeys(before)

      expect(summary).toMatchObject({
        status: "paid",
        customerId: "ada",
        total: placed.total,
        chargeId: ledger.charges.get(key!)?.chargeId,
        shipments: placed.shipments,
      })
      expect(summary.lines.map(({ sku }) => sku)).toEqual(["kettle", "mug", "tea"])
      expect(tracking).toEqual([
        { order: "o-1", package: "bulky", skus: ["kettle"], status: "ready" },
        { order: "o-1", package: "small", skus: ["mug", "tea"], status: "ready" },
      ])
      expect(newKeys(before)).toHaveLength(1)
      expect(ledger.charges.get(key!)).toMatchObject({ customerId: "ada", amount: placed.total })
      expect(yield* test.inspect(order.ref)).toMatchObject({
        rows: { order_lines: 3 },
        events: 2,
        outbox: 0,
        effects: 0,
      })

      for (const child of placed.shipments)
        expect(
          yield* test.receiptsFor({ ...order.ref, actor: "Shipment", id: child }, "Open"),
        ).toBe(1)
    }),
  ))

it("replays a retried Place from its receipt and refuses the same id with other input", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const before = new Set(ledger.calls.keys())
      const order = yield* Order.get(OrderId.make("o-2"))
      const commandId = yield* (yield* Actors).mintCommandId
      const place = order.Place({ customer: ada, lines: [kettle] }).pipe(Actor.commandId(commandId))

      const first = yield* place
      expect(yield* place).toEqual(first)

      const changed = yield* order
        .Place({ customer: ada, lines: [{ ...kettle, unitPrice: 1 }] })
        .pipe(Actor.commandId(commandId), Effect.flip)

      expect(Schema.is(ActorError)(changed) && changed.reason).toBeInstanceOf(CommandConflict)

      yield* settled("o-2")
      expect(yield* test.receiptsFor(order.ref, "Place")).toBe(1)
      expect(newKeys(before)).toHaveLength(1)
    }),
  ))

it("refuses a second order under a placed order id and changes nothing", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const order = yield* Order.get(OrderId.make("o-3"))
      yield* order.Place({ customer: ada, lines: [kettle] })
      yield* settled("o-3")

      const again = yield* order.Place({ customer: ada, lines: [mugs] }).pipe(Effect.flip)

      expect(again).toBeInstanceOf(OrderAlreadyPlaced)
      expect(yield* test.inspect(order.ref)).toMatchObject({
        rows: { order_lines: 1 },
        events: 2,
        outbox: 0,
      })
    }),
  ))

it("mints the same shipment ids when a crash before COMMIT reruns Place", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const order = yield* Order.get(OrderId.make("o-4"))
      const commandId = yield* (yield* Actors).mintCommandId

      const place = order
        .Place({ customer: ada, lines: [kettle, mugs] })
        .pipe(Actor.commandId(commandId))

      yield* test.crashNext("beforeCommit")
      const placed = yield* place

      expect(yield* place).toEqual(placed)

      const { tracking } = yield* settled("o-4")
      expect(tracking.map(({ status }) => status)).toEqual(["ready", "ready"])

      for (const child of placed.shipments)
        expect(
          yield* test.receiptsFor({ ...order.ref, actor: "Shipment", id: child }, "Open"),
        ).toBe(1)
    }),
  ))

it("applies one charge when the executor's result is lost after the provider applied it", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const before = new Set(ledger.calls.keys())
      const order = yield* Order.get(OrderId.make("o-5"))

      // The first attempt's result is lost after the provider answered, so the relay runs it again.
      yield* test.crashNext("afterExecute")
      yield* order.Place({ customer: ada, lines: [kettle] })

      while (newKeys(before).length === 0) yield* Effect.sleep("20 millis")

      // The crashed attempt keeps its lease; the next attempt runs once the lease has passed.
      yield* test.advance("2 minutes")
      const { summary } = yield* settled("o-5")
      const [key] = newKeys(before)

      expect(ledger.calls.get(key!)).toBe(2)
      expect(ledger.charges.get(key!)?.chargeId).toBe(summary.chargeId)
      expect(summary.status).toBe("paid")
      expect(yield* test.receiptsFor(order.ref, "Charged")).toBe(1)
    }),
  ))

it("dead-letters a declined charge, fails the order, and cancels its shipments", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const before = new Set(ledger.calls.keys())
      const order = yield* Order.get(OrderId.make("o-6"))
      yield* order.Place({ customer: ada, lines: [piano, mugs] })

      const { summary, tracking } = yield* settled("o-6")
      const [key] = newKeys(before)

      expect(summary.status).toBe("payment_failed")
      expect(summary.chargeId).toBeUndefined()
      expect(tracking.map(({ status }) => status)).toEqual(["cancelled", "cancelled"])
      expect(ledger.calls.get(key!)).toBe(4)
      expect(ledger.charges.has(key!)).toBe(false)
      expect(yield* test.receiptsFor(order.ref, "ChargeFailed")).toBe(1)
    }),
  ))
