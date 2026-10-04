import { BunCrypto } from "@effect/platform-bun"
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect"
import { pgTable, text } from "drizzle-orm/pg-core"
import { afterAll, describe, expect, it } from "vitest"
import { Actor, ActorError } from "../index.ts"
import { ActorTest } from "../testing/actor-test.ts"
import type { InternalActors } from "../runtime/actors.ts"
import { Request } from "../runtime/request.ts"
import { ActorRef, System } from "../identity/caller.ts"
import { descriptorOf } from "./descriptor.ts"
import { turnsOf } from "./turns.ts"

const Receipt = Schema.Struct({ providerId: Schema.String })

const Charge = Actor.job("Charge", { payload: { amount: Schema.Int }, success: Receipt })

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const Place = Actor.command("Place", { payload: { amount: Schema.Int }, error: Refused })

const Paid = Actor.command("Paid", { payload: Receipt })

const Order = Actor.make("TurnsOrder", {
  key: Schema.String,
  state: Actor.state({
    paidWith: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  }),
  api: { Place },
  internal: { Paid },
  jobs: { Charge: { job: Charge, onSuccess: Paid, retry: { times: 0 } } },
})

const Audit = Actor.command("Audit", { payload: { amount: Schema.Int } })

const Noted = Actor.command("Noted", { payload: Receipt })

const Ledger = Actor.make("TurnsLedger", {
  key: Schema.String,
  state: Actor.state({
    notes: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  api: { Audit },
  internal: { Noted },
  jobs: { Charge: { job: Charge, onSuccess: Noted, concurrency: { perActor: 1 } } },
})

const Placed = Actor.event("TurnsPlaced", { customer: Schema.String })

const Shop = Actor.command("Shop", { payload: { customer: Schema.String } })

const Store = Actor.make("TurnsStore", { key: Schema.String, events: [Placed], api: { Shop } })

const StoreDelivery = Actor.Delivery({ source: Store, events: [Placed] })

const Tally = Actor.command("Tally", { payload: StoreDelivery })

const Customer = Actor.make("TurnsCustomer", {
  key: Schema.String,
  state: Actor.state({ orders: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: {},
  internal: { Tally },
  subscriptions: [
    Actor.subscription("FromStore", {
      delivery: StoreDelivery,
      handler: Tally,
      route: (event) => event.customer,
    }),
  ],
})

const Open = Actor.command("Open")

const Tick = Actor.command("Tick")

const Peek = Actor.command("Peek", { success: Schema.Int })

const Clock = Actor.make("TurnsClock", {
  key: Schema.String,
  state: Actor.state({ ticks: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Open, Peek },
  internal: { Tick },
  createdBy: Open,
  schedules: { "@every 1 second": Tick },
})

/** Every executor call per actor type, with the job id it saw, in call order. */
const calls: Array<{ readonly actor: string; readonly jobId: string; readonly amount: number }> = []

const live = Layer.mergeAll(
  Order.toLayer({
    Place: Effect.fn(function* ({ amount }) {
      const turn = yield* Order.Turn
      yield* turn.enqueue(Charge.make({ amount }))

      if (amount < 0) return yield* Refused.make({})
    }),
    Paid: Effect.fn(function* ({ providerId }) {
      yield* (yield* Order.Turn).state.set({ paidWith: providerId })
    }),
  }),
  Order.toJobLayer({
    Charge: Effect.fn(function* ({ amount }) {
      const executor = yield* Order.Executor
      calls.push({ actor: "order", jobId: executor.jobId, amount })

      return { providerId: `order-${amount}` }
    }),
  }),
  Ledger.toLayer({
    Audit: Effect.fn(function* ({ amount }) {
      yield* (yield* Ledger.Turn).enqueue(Charge.make({ amount }))
    }),
    Noted: Effect.fn(function* ({ providerId }) {
      const turn = yield* Ledger.Turn
      yield* turn.state.set({ notes: [...turn.state.notes, providerId] })
    }),
  }),
  Ledger.toJobLayer({
    Charge: Effect.fn(function* ({ amount }) {
      const executor = yield* Ledger.Executor
      calls.push({ actor: "ledger", jobId: executor.jobId, amount })

      return { providerId: `ledger-${amount}` }
    }),
  }),
  Store.toLayer({
    Shop: Effect.fn(function* ({ customer }) {
      yield* (yield* Store.Turn).emit(Placed.make({ customer }))
    }),
  }),
  Customer.toLayer({
    Tally: Effect.fn(function* (delivery) {
      const turn = yield* Customer.Turn

      if (Predicate.isTagged(delivery, "Event"))
        yield* turn.state.set({ orders: turn.state.orders + 1 })
    }),
  }),
  Clock.toLayer({
    Open: () => Effect.void,
    Peek: Effect.fn(function* () {
      return (yield* Clock.Turn).state.ticks
    }),
    Tick: Effect.fn(function* () {
      const turn = yield* Clock.Turn
      yield* turn.state.set({ ticks: turn.state.ticks + 1 })
    }),
  }),
).pipe(Layer.provideMerge(ActorTest.layer({})), Layer.provide(BunCrypto.layer))

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

describe("actor turns through the runtime", () => {
  it("routes one shared job to each binding's own command after commit, never after a rollback", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const order = yield* Order.get("o")
        const ledger = yield* Ledger.get("l")

        const refused = yield* order.Place({ amount: -1 }).pipe(Effect.flip)
        expect(refused).toBeInstanceOf(Refused)
        yield* test.advance(0)
        expect(calls).toEqual([])
        expect(yield* test.inspect(order.ref)).toMatchObject({ jobs: 0, outbox: 0 })

        yield* order.Place({ amount: 713 })
        yield* ledger.Audit({ amount: 5 })
        yield* test.advance(0)

        expect(calls.map(({ actor, amount }) => [actor, amount])).toEqual([
          ["order", 713],
          ["ledger", 5],
        ])
        expect(new Set(calls.map(({ jobId }) => jobId)).size).toBe(2)
        expect((yield* test.inspect(order.ref)).state).toEqual({ paidWith: "order-713" })
        expect((yield* test.inspect(ledger.ref)).state).toEqual({ notes: ["ledger-5"] })
        expect(yield* test.receiptsFor(order.ref, "Paid")).toBe(1)
      }),
    ))

  it("delivers a source's events through the subscription's delivery to its handler", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const store = yield* Store.get("s")
        yield* store.Shop({ customer: "ada" })
        yield* store.Shop({ customer: "ada" })
        yield* store.Shop({ customer: "bob" })
        yield* test.advance(0)

        const ada = ActorRef.make({ tenant: test.tenant, actor: Customer.name, id: "ada" })
        const bob = ActorRef.make({ tenant: test.tenant, actor: Customer.name, id: "bob" })

        expect((yield* test.inspect(ada)).state).toEqual({ orders: 2 })
        expect((yield* test.inspect(bob)).state).toEqual({ orders: 1 })
      }),
    ))

  it("creates only through createdBy and runs actor-level schedules", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const clock = yield* Clock.get("c")

        const early = yield* clock.Peek().pipe(Effect.flip)
        expect(Schema.is(ActorError)(early) && early.reason._tag).toBe("NotCreated")

        yield* clock.Open()
        yield* test.advance("1 second")
        yield* test.advance("1 second")

        expect(yield* test.receiptsFor(clock.ref, "Tick")).toBeGreaterThanOrEqual(1)
        expect(yield* clock.Peek()).toBe(yield* test.receiptsFor(clock.ref, "Tick"))
      }),
    ))
})

describe("batched reducers", () => {
  const Log = Actor.state({
    log: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  })

  const Append = Actor.reducer("Append", {
    state: Log,
    payload: Schema.String,
    reduce: (state, text) => Result.succeed({ log: state.log + text }),
    batch: { combine: (first, second) => first + second },
  })

  const Journal = Actor.make("BatchJournal", { key: Schema.String, state: Log, api: { Append } })

  it("folds queued calls in their order, so a non-commutative combine still equals sequential turns", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const descriptor = descriptorOf(Journal)!
        const codec = descriptor.codecs.get("Append")!

        const commands = yield* turnsOf({
          descriptor,
          Turn: Journal.Turn,
          handlers: {},
          services: Context.empty(),
          actors: {} as InternalActors["Service"],
        })

        const ref = ActorRef.make({ tenant: "t", actor: Journal.name, id: "j" })

        const requests = yield* Effect.forEach(["a", "b", "c"], (text, index) =>
          Effect.map(codec.encodePayload({ value: text }), (payload) =>
            Request.make({
              ref,
              caller: System.make({ source: "process" }),
              command: "Append",
              commandId: `c${index}`,
              payload,
            }),
          ),
        )

        const merged = yield* commands.get("Append")!.merge!(requests, [["log", '"x"']])

        expect(merged.state).toEqual([["log", '"xabc"']])
      }),
    ))
})

describe("table and blob capabilities of a turn", () => {
  const shelved = Actor.table(pgTable("turns_shelved", { id: text("id").primaryKey() }))
  const covers = Actor.blob("covers")
  const Idle = Actor.command("Idle")
  const UseRows = Actor.command("UseRows")
  const UseBlob = Actor.command("UseBlob")

  const Shelf = Actor.make("TurnsShelf", {
    key: Schema.String,
    tables: [shelved],
    blobs: [covers],
    api: { Idle, UseRows, UseBlob },
  })

  const tableFailure = new Error("table binding failed")
  const blobFailure = new Error("blob binding failed")

  /** The running turn, read without declaring it, as an erased handler does. */
  const turn = Effect.map(Effect.serviceOption(Shelf.Turn), Option.getOrThrow)

  it("binds only what a handler uses, and a failed binding is that turn's defect", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const bound = { tables: 0, blobs: 0 }
        const descriptor = descriptorOf(Shelf)!

        const bindings: Pick<InternalActors["Service"], "tables" | "blobs"> = {
          tables: () => {
            bound.tables += 1

            return Effect.die(tableFailure)
          },
          blobs: () => {
            bound.blobs += 1

            return Effect.die(blobFailure)
          },
        }

        const commands = yield* turnsOf({
          descriptor,
          Turn: Shelf.Turn,
          handlers: {
            Idle: () => Effect.void,
            UseRows: () => Effect.flatMap(turn, (current) => current.rows(shelved).count()),
            UseBlob: () => Effect.flatMap(turn, (current) => current.blob(covers).get("front")),
          },
          services: Context.empty(),
          actors: bindings as InternalActors["Service"],
        })

        const run = (command: string) =>
          commands.get(command)!.run(
            Request.make({
              ref: ActorRef.make({ tenant: "t", actor: Shelf.name, id: "s" }),
              caller: System.make({ source: "process" }),
              command,
              commandId: `${command}-1`,
              payload: '{"value":null}',
            }),
            [],
            { head: "0" },
          )

        expect(Exit.isSuccess(yield* Effect.exit(run("Idle")))).toBe(true)
        expect(bound).toEqual({ tables: 0, blobs: 0 })

        const rows = yield* Effect.exit(run("UseRows"))
        expect(Exit.isFailure(rows) && Cause.squash(rows.cause)).toBe(tableFailure)

        const blob = yield* Effect.exit(run("UseBlob"))
        expect(Exit.isFailure(blob) && Cause.squash(blob.cause)).toBe(blobFailure)
        expect(bound).toEqual({ tables: 1, blobs: 1 })
      }),
    ))
})
