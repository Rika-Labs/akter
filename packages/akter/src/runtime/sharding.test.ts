import { createServer } from "node:net"
import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Result,
  Scope,
  Schema,
  Stream,
} from "effect"
import { describe, expect, it } from "vitest"
import { Actor, user } from "../index.ts"
import { CommandIds } from "../execution/command-ids.ts"
import type { Catalog } from "../execution/durable.ts"
import { Durable } from "../execution/durable.ts"
import { Engine } from "../execution/engine.ts"
import { memoryBucket } from "../store/memory.ts"
import { Store, storeOf } from "../store/service.ts"
import { RunnerAuthority } from "./peering/authority.ts"
import { Routing } from "./sharding.ts"

const Ledger = Actor.make("Ledger", {
  state: Schema.Struct({
    total: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    deliveries: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  actions: {
    add: Actor.action(Schema.Finite, { success: Schema.Finite }),
    send: Actor.action(Schema.Struct({ to: Schema.String, amount: Schema.Finite })),
    receive: Actor.action(Schema.Finite, { internal: true }),
    remind: Actor.action(Schema.Finite),
  },
})

const LedgerLive = Ledger.toLayer({
  add: (ledger, amount) => {
    ledger.total += amount
    return ledger.total
  },
  send: (_, { to, amount }, { send }) => {
    send(Ledger, to).receive(amount)
  },
  receive: (ledger, amount) => {
    ledger.total += amount
    ledger.deliveries++
  },
  remind: (_, amount, { schedule }) => {
    schedule("100 millis").receive(amount)
  },
})

const port = Effect.callback<number>((resume) => {
  const listener = createServer()
  listener.listen(0, "127.0.0.1", () => {
    const address = listener.address()
    const parsed = Schema.decodeUnknownResult(Schema.Struct({ port: Schema.Int }))(address)
    listener.close(() =>
      Result.isSuccess(parsed)
        ? resume(Effect.succeed(parsed.success.port))
        : resume(Effect.die(new Error("no TCP address"))),
    )
  })
})

const setup = Effect.gen(function* () {
  const bucket = memoryBucket()
  const authority = yield* RunnerAuthority.make()
  const credentials = yield* authority.issue({ deployment: "store-cluster" })
  const context = yield* Layer.build(LedgerLive)
  const catalog: Catalog = {
    actors: new Map([
      [Ledger.name, { actor: Ledger, registered: Context.get(context, Ledger.implementation) }],
    ]),
    shards: 4,
  }
  const runners = []
  for (let index = 0; index < 2; index++) {
    const scope = yield* Scope.fork(yield* Effect.scope)
    const store = yield* storeOf(bucket, { shards: 4, writer: `runner-${index}` })
    const engine = yield* Engine.make(catalog, {
      shards: 4,
      policy: "matching",
      maxBatch: 64,
      checkpointEvery: 64,
      cronSkipIfOlderThan: 3_600_000,
      doubleRun: true,
      observer: undefined,
    }).pipe(Effect.provideService(Store, store), Effect.provideService(Scope.Scope, scope))
    const routing = yield* Routing.make(engine, {
      address: { host: "127.0.0.1", port: yield* port },
      peering: { deployment: "store-cluster", credentials: Effect.succeed(credentials) },
      shardLockExpiration: "3 seconds",
      shardLockRefreshInterval: "1 second",
      refreshAssignmentsInterval: "100 millis",
    }).pipe(Effect.provideService(Store, store), Effect.provideService(Scope.Scope, scope))
    runners.push({ engine, routing, scope })
  }
  for (let poll = 0; poll < 500; poll++) {
    const counts = runners.map(
      ({ engine }) =>
        Array.from({ length: 4 }, (_, id) => engine.status(id).status === "open").filter(Boolean)
          .length,
    )
    if (counts.every((count) => count > 0) && counts.reduce((a, b) => a + b, 0) === 4)
      return { runners, bucket }
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die(
    new Error(
      `cluster did not split: ${runners
        .map(({ engine }) =>
          engine
            .shards()
            .map(({ id, status }) => `${id}:${status}`)
            .join(","),
        )
        .join(";")}`,
    ),
  )
})

describe("bucket-backed Cluster routing", () => {
  it(
    "F16 rejects executing a request on the gateway instead of its owner; the same id returns the durable outcome",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { runners } = yield* setup
            const gateway = runners[0]!
            const owner = runners[1]!
            let key = ""
            for (let candidate = 0; candidate < 100; candidate++) {
              key = `account-${candidate}`
              if (
                owner.engine.status(Durable.shardOf(Durable.addressOf(Ledger.name, key), 4))
                  .status === "open"
              )
                break
            }
            const id = yield* Effect.flatMap(Clock.currentTimeMillis, CommandIds.mint)
            const request = { actor: Ledger, id: key, member: "add", payload: 17 }
            expect(yield* gateway.routing.admitted(user("ana"), id, request)).toEqual({
              reply: { kind: "Success", value: 17 },
              replayed: false,
            })
            expect(yield* gateway.routing.admitted(user("ana"), id, request)).toEqual({
              reply: { kind: "Success", value: 17 },
              replayed: true,
            })
            const frame = yield* Stream.runHead(
              gateway.routing.reads(user("ana")).state({ actor: Ledger, id: key }),
            )
            expect(frame).toHaveProperty("value.value.total", 17)
            expect(
              gateway.engine.durableImage(Durable.shardOf(Durable.addressOf(Ledger.name, key), 4)),
            ).toBeUndefined()
          }),
        ),
      ),
    15_000,
  )

  it(
    "F13 rejects local-only cross-shard delivery and loss or duplication through sender handoff",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { runners } = yield* setup
            const a = runners[0]!
            const b = runners[1]!
            const keys = runners.map(({ engine }, index) => {
              for (let candidate = 0; candidate < 100; candidate++) {
                const key = `${index}-${candidate}`
                if (
                  engine.status(Durable.shardOf(Durable.addressOf(Ledger.name, key), 4)).status ===
                  "open"
                )
                  return key
              }
              throw new Error("no key on runner")
            })
            const id = yield* Effect.flatMap(Clock.currentTimeMillis, CommandIds.mint)
            yield* a.routing.admitted(user("ana"), id, {
              actor: Ledger,
              id: keys[0]!,
              member: "send",
              payload: { to: keys[1]!, amount: 23 },
            })
            const report = yield* a.routing.drain("5 seconds")
            expect(report.outcome).toBe("clean")
            for (let poll = 0; poll < 500; poll++) {
              const result = yield* Effect.result(
                Stream.runHead(b.routing.reads(user("ana")).state({ actor: Ledger, id: keys[1]! })),
              )
              if (
                Result.isSuccess(result) &&
                Option.isSome(result.success) &&
                result.success.value.kind === "Frame" &&
                Predicate.isObject(result.success.value.value) &&
                result.success.value.value["total"] === 23
              ) {
                expect(result.success.value.value).toEqual({ total: 23, deliveries: 1 })
                return
              }
              yield* Effect.sleep("10 millis")
            }
            return yield* Effect.die(new Error("send did not survive handoff"))
          }),
        ),
      ),
    15_000,
  )
})
