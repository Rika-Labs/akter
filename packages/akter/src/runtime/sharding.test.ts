import { createServer } from "node:net"
import {
  Clock,
  Context,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Result,
  Scope,
  Schema,
  Stream,
} from "effect"
import { describe, expect, it } from "vitest"
import { Actor, anonymous, isAuthenticated, isUser, user } from "../index.ts"
import { Akter, App, Auth, RuntimeControl } from "../server.ts"
import { AkterClient } from "../client/index.ts"
import { HttpServer } from "effect/http"
import type { Caller } from "../contract/caller.ts"
import type { AccessRequest } from "../contract/make.ts"
import { CommandIds } from "../execution/command-ids.ts"
import { Entry, EntryCodec } from "../execution/entries.ts"
import type { Catalog } from "../execution/durable.ts"
import { Durable } from "../execution/durable.ts"
import { Engine } from "../execution/engine.ts"
import type { Bucket } from "../store/bucket.ts"
import { memoryBucket } from "../store/memory.ts"
import { Store, storeOf } from "../store/service.ts"
import { RunnerAuthority } from "./peering/authority.ts"
import { Routing, type RunnerOptions } from "./sharding.ts"

let findChecks = 0
const Ledger = Actor.make("Ledger", {
  state: Schema.Struct({
    total: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    deliveries: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  commands: {
    add: Actor.command(Schema.Finite, { success: Schema.Finite }),
    send: Actor.command(Schema.Struct({ to: Schema.String, amount: Schema.Finite })),
    receive: Actor.command(Schema.Finite, { internal: true }),
    remind: Actor.command(Schema.Finite),
  },
  access: (caller: Caller, request: AccessRequest) => {
    if (request.kind === "find") findChecks++
    return request.kind === "command" && request.member === "add"
      ? isUser(caller) && caller.subject === "ana"
      : isAuthenticated(caller)
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

const setup = (
  requestTimeout: Duration.Input = "10 seconds",
  count = 2,
  timing: Pick<
    RunnerOptions,
    "shardLockExpiration" | "shardLockRefreshInterval" | "refreshAssignmentsInterval"
  > = {
    shardLockExpiration: "3 seconds",
    shardLockRefreshInterval: "1 second",
    refreshAssignmentsInterval: "100 millis",
  },
  wrap: (index: number, bucket: Bucket) => Bucket = (_, bucket) => bucket,
) =>
  Effect.gen(function* () {
    const bucket = { ...memoryBucket() }
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
    for (let index = 0; index < count; index++) {
      const scope = yield* Scope.fork(yield* Effect.scope)
      const store = yield* storeOf(wrap(index, bucket), { shards: 4, writer: `runner-${index}` })
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
        ...timing,
        requestTimeout,
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
    "T6 rejects waiting for the membership tick after durable release over real mTLS",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { runners, bucket } = yield* setup("10 seconds", 2, {
              shardLockExpiration: "30 seconds",
              shardLockRefreshInterval: "2 seconds",
              refreshAssignmentsInterval: "4 seconds",
            })
            const old = runners[0]!
            const next = runners[1]!
            const moved = Array.from({ length: 4 }, (_, id) => id).filter(
              (id) => old.engine.status(id).status === "open",
            )
            const began = performance.now()
            expect((yield* old.routing.drain("5 seconds")).outcome).toBe("clean")
            for (let poll = 0; poll < 250; poll++) {
              if (
                Array.from({ length: 4 }, (_, id) => id).every(
                  (id) => next.engine.status(id).status === "open",
                ) &&
                (yield* next.routing.readiness).ready
              )
                break
              yield* Effect.sleep("10 millis")
            }
            expect(performance.now() - began).toBeLessThan(2500)
            expect(Array.from({ length: 4 }, (_, id) => next.engine.status(id).status)).toEqual([
              "open",
              "open",
              "open",
              "open",
            ])
            expect(yield* bucket.leases.list("cluster/runners/")).toHaveLength(1)
            const store = yield* storeOf(bucket, { shards: 4 })
            for (const shard of moved) {
              const segments = Array.from(yield* Stream.runCollect(store.read(shard, 0n)))
              const opened = segments.findIndex((segment) => segment.writer === "runner-1")
              expect(opened).toBeGreaterThan(0)
              expect(
                segments[opened - 1]!.entries.map((entry) =>
                  Result.getOrThrow(EntryCodec.decode(entry)),
                ).some(Entry.guards.Released),
              ).toBe(true)
            }
          }),
        ),
      ),
    15_000,
  )

  it(
    "keeps every advisory lock and heartbeat through a drain whose Released write outlasts lock expiration",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            let slow = false
            const { runners, bucket } = yield* setup("10 seconds", 2, undefined, (index, bucket) =>
              index === 0
                ? {
                    ...bucket,
                    create: (key, body) =>
                      slow && key.includes("/log/")
                        ? Effect.delay(bucket.create(key, body), "4 seconds")
                        : bucket.create(key, body),
                  }
                : bucket,
            )
            const old = runners[0]!
            const next = runners[1]!
            const moved = Array.from({ length: 4 }, (_, id) => id).filter(
              (id) => old.engine.status(id).status === "open",
            )
            slow = true
            expect((yield* old.routing.drain("10 seconds")).outcome).toBe("clean")
            for (let poll = 0; poll < 500; poll++) {
              if (
                Array.from({ length: 4 }, (_, id) => id).every(
                  (id) => next.engine.status(id).status === "open",
                )
              )
                break
              yield* Effect.sleep("10 millis")
            }
            expect(Array.from({ length: 4 }, (_, id) => next.engine.status(id).status)).toEqual([
              "open",
              "open",
              "open",
              "open",
            ])
            const store = yield* storeOf(bucket, { shards: 4 })
            for (const shard of moved) {
              const segments = Array.from(yield* Stream.runCollect(store.read(shard, 0n)))
              const last = segments.findLastIndex((segment) => segment.writer === "runner-0")
              expect(
                segments[last]!.entries.map((entry) =>
                  Result.getOrThrow(EntryCodec.decode(entry)),
                ).some(Entry.guards.Released),
              ).toBe(true)
            }
          }),
        ),
      ),
    20_000,
  )

  it(
    "scatter-gathers ids from durable owner indexes with one access check, a global limit and id ties over real mTLS peering",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { runners } = yield* setup()
            const gateway = runners[0]!.routing
            for (const [id, total] of [
              ["z", 17],
              ["c", 29],
              ["b", 17],
              ["m", 8],
              ["a", 5],
            ] as const)
              yield* gateway.admitted(
                user("ana"),
                yield* CommandIds.mint(yield* Clock.currentTimeMillis),
                { actor: Ledger, id, member: "add", payload: total },
              )
            findChecks = 0
            const request = {
              actor: Ledger,
              query: {
                where: { total: { gte: 8, lte: 29 } },
                orderBy: { field: "total" as never },
                limit: 3,
              },
            }
            expect(yield* gateway.reads(user("ana")).find(request)).toEqual(["m", "b", "z"])
            expect(findChecks).toBe(1)
            expect((yield* Effect.flip(gateway.reads(anonymous).find(request))).reason._tag).toBe(
              "Unauthorized",
            )
            expect(findChecks).toBe(2)
          }),
        ),
      ),
    20_000,
  )
  it(
    "F16 serves the real public HTTP/WebSocket client through a non-owner and resubscribes its live state after owner drain",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const bucket = memoryBucket()
            const authority = yield* RunnerAuthority.make()
            const app = App.make({ actors: [Ledger], layer: LedgerLive })
            const auth = Auth.make(() => Effect.succeed({ caller: user("ana"), tenant: "default" }))
            const servers = []
            for (let index = 0; index < 2; index++) {
              const advertised = { host: "127.0.0.1", port: yield* port }
              const store = yield* storeOf(bucket, { shards: 4, writer: `served-${index}` })
              const credentials = yield* authority.issue({ deployment: "served-store" })
              const context = yield* Layer.build(
                Akter.serve({
                  app,
                  auth,
                  port: 0,
                  hostname: "127.0.0.1",
                  runner: {
                    address: advertised,
                    peering: {
                      deployment: "served-store",
                      credentials: Effect.succeed(credentials),
                    },
                    shardLockExpiration: "3 seconds",
                    shardLockRefreshInterval: "1 second",
                    refreshAssignmentsInterval: "100 millis",
                  },
                }).pipe(Layer.provide(Layer.succeed(Store, store))),
              )
              const address = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ port: Schema.Int }),
              )(Context.get(context, HttpServer.HttpServer).address)
              servers.push({
                port: address.port,
                control: Context.get(context, RuntimeControl),
                advertised: `${advertised.host}:${advertised.port}`,
              })
            }
            const gateway = servers[0]!
            const owner = servers[1]!
            const locks = new Map<number, string>()
            for (let poll = 0; poll < 500; poll++) {
              locks.clear()
              for (let id = 0; id < 4; id++) {
                const object = yield* bucket.leases.read(`cluster/locks/default%3A${id + 1}`)
                if (Option.isNone(object)) continue
                const lock = yield* Schema.decodeEffect(
                  Schema.fromJsonString(Schema.Struct({ address: Schema.NullOr(Schema.String) })),
                )(new TextDecoder().decode(object.value.body))
                if (lock.address !== null) locks.set(id, lock.address)
              }
              if (
                locks.size === 4 &&
                Array.from(locks.values()).includes(owner.advertised) &&
                (yield* gateway.control.readiness).ready &&
                (yield* owner.control.readiness).ready
              )
                break
              yield* Effect.sleep("10 millis")
            }
            const keyOn = (address: string) => {
              for (let candidate = 0; candidate < 100; candidate++) {
                const key = `served-${candidate}`
                if (locks.get(Durable.shardOf(Durable.addressOf(Ledger.name, key), 4)) === address)
                  return key
              }
              throw new Error("no assigned actor key")
            }
            const from = keyOn(gateway.advertised)
            const target = keyOn(owner.advertised)
            for (const [scheme, amount, expected] of [
              ["http", 17, 24],
              ["ws", 29, 60],
            ] as const) {
              const context = yield* Layer.build(
                AkterClient.layer({
                  url: `${scheme}://127.0.0.1:${gateway.port}/rpc`,
                  actors: [Ledger],
                }),
              )
              yield* Effect.gen(function* () {
                const sender = yield* Ledger.client(from)
                const receiver = yield* Ledger.client(target)
                yield* receiver.add(amount)
                yield* sender.send({ to: target, amount: 7 })
                const value = yield* Stream.runHead(
                  receiver.state.pipe(Stream.filter((state) => state.total === expected)),
                )
                expect(Option.getOrThrow(value).total).toBe(expected)
              }).pipe(Effect.provideContext(context))
            }
            const context = yield* Layer.build(
              AkterClient.layer({ url: `http://127.0.0.1:${gateway.port}/rpc`, actors: [Ledger] }),
            )
            yield* Effect.gen(function* () {
              const receiver = yield* Ledger.client(target)
              const subscribed = yield* Deferred.make<void>()
              const observed: Array<number> = []
              const changed = yield* receiver.state.pipe(
                Stream.tap((state) =>
                  Effect.andThen(
                    Effect.sync(() => observed.push(state.total)),
                    Deferred.succeed(subscribed, undefined),
                  ),
                ),
                Stream.filter((state) => state.total === 71),
                Stream.runHead,
                Effect.forkScoped,
              )
              yield* Deferred.await(subscribed)
              expect((yield* owner.control.drain({ deadline: "5 seconds" })).outcome).toBe("clean")
              expect(yield* receiver.add(11)).toBe(71)
              expect(Option.getOrThrow(yield* Fiber.join(changed))).toEqual({
                total: 71,
                deliveries: 2,
              })
              expect(observed).toEqual([60, 71])
            }).pipe(Effect.provideContext(context))
            const store = yield* storeOf(bucket, { shards: 4 })
            const segments = yield* Stream.runCollect(
              store.read(Durable.shardOf(Durable.addressOf(Ledger.name, target), 4), 0n),
            )
            const adds = Array.from(segments)
              .flatMap((segment) =>
                segment.entries.map((bytes) => ({
                  writer: segment.writer,
                  entry: Result.getOrThrow(EntryCodec.decode(bytes)),
                })),
              )
              .filter(({ entry }) => Entry.guards.Action(entry) && entry.member === "add")
            expect(adds.map(({ writer }) => writer)).toEqual(["served-1", "served-1", "served-0"])
          }),
        ),
      ),
    20_000,
  )
  it(
    "F24 rejects hanging shutdown on a shard refused because its actionable tail belongs to another build",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { runners, bucket } = yield* setup("10 seconds", 1)
            const old = runners[0]!
            const id = yield* Effect.flatMap(Clock.currentTimeMillis, CommandIds.mint)
            yield* old.routing.admitted(user("ana"), id, {
              actor: Ledger,
              id: "build-tail",
              member: "add",
              payload: 41,
            })
            yield* Scope.close(old.scope, Exit.void)
            const scope = yield* Scope.fork(yield* Effect.scope)
            const store = yield* storeOf(bucket, {
              shards: 4,
              writer: "new-build",
              build: { bundle: "new", framework: "" },
            })
            const engine = yield* Engine.make(old.engine.catalog, old.engine.options).pipe(
              Effect.provideService(Store, store),
              Effect.provideService(Scope.Scope, scope),
            )
            const authority = yield* RunnerAuthority.make()
            const credentials = yield* authority.issue({ deployment: "store-cluster" })
            yield* Routing.make(engine, {
              address: { host: "127.0.0.1", port: yield* port },
              peering: { deployment: "store-cluster", credentials: Effect.succeed(credentials) },
              shardLockExpiration: "3 seconds",
              shardLockRefreshInterval: "1 second",
              refreshAssignmentsInterval: "100 millis",
            }).pipe(Effect.provideService(Store, store), Effect.provideService(Scope.Scope, scope))
            const shard = engine.shardOf(Durable.addressOf(Ledger.name, "build-tail"))
            for (let poll = 0; poll < 500 && engine.status(shard).status !== "refused"; poll++)
              yield* Effect.sleep("10 millis")
            expect(engine.status(shard).status).toBe("refused")
            yield* Scope.close(scope, Exit.void).pipe(Effect.timeout("5 seconds"))
            expect(yield* bucket.leases.list("cluster/runners/")).toHaveLength(0)
          }),
        ),
      ),
    15_000,
  )
  it(
    "F16 rejects executing a request on the gateway instead of its owner; the same id returns the durable outcome",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { runners } = yield* setup()
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
            const denied = yield* Effect.flip(gateway.routing.admitted(user("ben"), id, request))
            expect(denied.reason).toHaveProperty("_tag", "Unauthorized")
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
            const { runners, bucket } = yield* setup()
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
            expect(yield* a.routing.readiness).toEqual({ ready: false, reason: "drained" })
            const stopped = yield* Effect.flip(
              a.routing.admitted(user("ana"), id, {
                actor: Ledger,
                id: keys[0]!,
                member: "add",
                payload: 3,
              }),
            )
            expect(stopped.reason).toHaveProperty("_tag", "ShardMoved")
            yield* Effect.sleep("200 millis")
            expect(yield* bucket.leases.list("cluster/runners/")).toHaveLength(1)
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

  it(
    "F16 rejects waiting without a bound on a partitioned owner or minting a fresh id after a lost reply",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const { runners, bucket } = yield* setup("50 millis")
            const gateway = runners[0]!
            const owner = runners[1]!
            let key = ""
            for (let candidate = 0; candidate < 100; candidate++) {
              key = `timeout-${candidate}`
              if (
                owner.engine.status(Durable.shardOf(Durable.addressOf(Ledger.name, key), 4))
                  .status === "open"
              )
                break
            }
            const gate = yield* Deferred.make<void>()
            const create = bucket.create
            bucket.create = (objectKey, bytes) =>
              objectKey.includes("/log/")
                ? Effect.andThen(Deferred.await(gate), create(objectKey, bytes))
                : create(objectKey, bytes)
            const id = yield* Effect.flatMap(Clock.currentTimeMillis, CommandIds.mint)
            const request = { actor: Ledger, id: key, member: "add", payload: 37 }
            const refused = yield* Effect.flip(gateway.routing.admitted(user("ana"), id, request))
            expect(refused.reason).toHaveProperty("_tag", "ActorUnavailable")
            expect((yield* owner.engine.durableRecord(Ledger, key)).image.state["total"]).toBe(0)
            yield* Deferred.succeed(gate, undefined)
            expect((yield* gateway.routing.admitted(user("ana"), id, request)).reply).toEqual({
              kind: "Success",
              value: 37,
            })
            expect((yield* gateway.routing.admitted(user("ana"), id, request)).replayed).toBe(true)
          }),
        ),
      ),
    15_000,
  )
})
