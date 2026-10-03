import { BunCrypto } from "@effect/platform-bun"
import {
  Config,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Scope,
  Schema,
  Stream,
} from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { Reactivity } from "effect/reactivity"
import { boundedPool, isPoolRefusal } from "./bounded.ts"
import { TurnConnections, turnConnections } from "../turn/pipeline.ts"
import { Coordination, coordinationLayer } from "./coordination.ts"
import { Actor } from "../../index.ts"
import { ActorTest } from "../../testing/actor-test.ts"
import { disposableDatabase } from "../../testing/database.ts"

describe("bounded Postgres checkout queues", () => {
  const runtime = ManagedRuntime.make(Layer.merge(Reactivity.layer, BunCrypto.layer))
  afterAll(() => runtime.dispose())
  it("retries checkout refusals while concurrently registering actor and query layers", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const database = yield* disposableDatabase({
            url: Redacted.make(yield* Config.String("TEST_DATABASE_URL")),
          })
          const Ping = Actor.command("Ping", { payload: Schema.Int, success: Schema.Int })
          const Value = Actor.query("Value", { success: Schema.Int })
          const actors = Array.from({ length: 80 }, (_, index) =>
            Actor.make(`StartupPool${index}`, {
              key: Schema.String,
              state: Actor.state({}),
              api: { Ping, Value },
            }),
          )
          const layers = actors.flatMap((actor) => [
            actor.toLayer(Effect.succeed({ Ping: (value: number) => Effect.succeed(value) })),
            actor.toQueryLayer(Effect.succeed({ Value: () => Effect.succeed(37) })),
          ])
          const live = yield* Effect.acquireRelease(
            Effect.sync(() =>
              ManagedRuntime.make(
                Layer.mergeAll(Layer.empty, ...layers).pipe(
                  Layer.provideMerge(ActorTest.layer({ database, maxConnections: 2 })),
                  Layer.provide(BunCrypto.layer),
                ),
              ),
            ),
            (live) => Effect.promise(() => live.dispose()),
          )
          yield* Effect.promise(() =>
            live.runPromise(
              Effect.gen(function* () {
                const test = yield* ActorTest
                for (const [index, actor] of actors.entries()) {
                  const handle = yield* actor.get("probe")
                  expect(yield* handle.Ping(index + 11)).toBe(index + 11)
                  expect(yield* handle.Value()).toBe(37)
                  expect(yield* test.inspect(handle.ref)).toMatchObject({ receipts: 1 })
                }
              }),
            ),
          )
        }),
      ),
    ))
  it("uses one connection for nested transactions and streaming reads without checking out again", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = Redacted.make(yield* Config.String("TEST_DATABASE_URL"))
          const sql = yield* boundedPool({ url, maxConnections: 1 })
          expect(
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const first = yield* sql<{ value: number }>`SELECT 13 AS value`
                const nested = yield* sql.withTransaction(
                  sql<{ value: number }>`SELECT 31 AS value`,
                )
                const streamed = yield* Stream.runCollect(
                  sql<{ value: number }>`SELECT 47 AS value`.stream,
                )
                return [first, nested, streamed]
              }),
            ),
          ).toEqual([[{ value: 13 }], [{ value: 31 }], [{ value: 47 }]])
          expect(
            yield* Stream.runCollect(sql<{ value: number }>`SELECT 59 AS value`.stream),
          ).toEqual([{ value: 59 }])
          expect(yield* sql`SELECT 71 AS value`).toEqual([{ value: 71 }])
        }),
      ),
    ))
  it.each(["off-turn", "coordination"] as const)(
    "refuses an excess %s statement before sending it and recovers every checkout after cancellation",
    (kind) =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const url = Redacted.make(yield* Config.String("TEST_DATABASE_URL"))
            const sql =
              kind === "off-turn"
                ? yield* boundedPool({ url, maxConnections: 1 })
                : Context.get(
                    yield* Layer.build(coordinationLayer({ url, maxConnections: 1 })),
                    Coordination,
                  )!
            yield* sql`CREATE TEMP TABLE load_shedding_probe (value integer)`
            const held = yield* Scope.fork(yield* Effect.scope)
            yield* sql.reserve.pipe(Scope.provide(held))
            const queued = yield* Effect.forEach(Array.from({ length: 64 }), () =>
              sql`SELECT 1`.pipe(Effect.forkScoped),
            )
            yield* Effect.sleep("50 millis")
            expect(queued.every((fiber) => fiber.pollUnsafe() === undefined)).toBe(true)
            const refused = yield* sql`INSERT INTO load_shedding_probe VALUES (17)`.pipe(
              Effect.exit,
            )
            expect(Exit.isFailure(refused)).toBe(true)
            expect(Exit.findErrorOption(refused)).toMatchObject({ value: { isRetryable: true } })
            for (const fiber of queued) yield* Fiber.interrupt(fiber)
            yield* Scope.close(held, Exit.void)
            expect(yield* sql`SELECT * FROM load_shedding_probe`).toEqual([])
            yield* sql`INSERT INTO load_shedding_probe VALUES (23)`
            expect(yield* sql`SELECT * FROM load_shedding_probe`).toEqual([{ value: 23 }])
          }),
        ),
      ),
  )

  it("bounds turn-session waiters independently of HTTP and releases cancelled leases", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = Redacted.make(yield* Config.String("TEST_DATABASE_URL"))
          const context = yield* Layer.build(turnConnections({ url, maxConnections: 1 }))
          const turns = Context.get(context, TurnConnections)
          const held = yield* Scope.fork(yield* Effect.scope)
          yield* turns.lease.pipe(Scope.provide(held))
          const release = yield* Deferred.make<void>()
          const queued = yield* Effect.forEach(Array.from({ length: 64 }), () =>
            Effect.scoped(Effect.andThen(turns.lease, Deferred.await(release))).pipe(
              Effect.forkScoped,
            ),
          )
          yield* Effect.sleep("10 millis").pipe(
            Effect.repeat({
              until: () => turns.sessions().waiting === 64,
            }),
          )
          const refused = yield* Effect.scoped(turns.lease).pipe(Effect.exit)
          const error = Exit.findErrorOption(refused)
          expect(error).toMatchObject({ value: { isRetryable: true } })
          expect(isPoolRefusal(Option.getOrThrow(error))).toBe(true)
          expect(turns.sessions()).toEqual({ leased: 1, waiting: 64 })
          for (const fiber of queued) yield* Fiber.interrupt(fiber)
          yield* Scope.close(held, Exit.void)
          expect(turns.sessions()).toEqual({ leased: 0, waiting: 0 })
          expect(
            yield* Effect.scoped(
              turns.lease.pipe(
                Effect.flatMap((connection) => connection.queryValues("SELECT 29", [])),
              ),
            ),
          ).toEqual([[29]])
        }),
      ),
    ))
})
