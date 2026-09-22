import { BunCrypto } from "@effect/platform-bun"
import {
  Cause,
  Config,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Schedule,
  Schema,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Actor, Actors, CurrentCaller, User } from "../../index.ts"
import {
  CommandConflict,
  CommandExpired,
  InvalidCommandId,
  Unauthorized,
} from "../../errors/actor.ts"
import { checkIdentity, databaseTime } from "../../runtime/turn/admission.ts"
import { payloadHash } from "../../runtime/turn/receipt.ts"
import { ActorTest } from "../actor-test.ts"

class Rejected extends Schema.TaggedError<Rejected>()("Rejected", { amount: Schema.Finite }) {}

const Increment = Actor.command("Increment", { input: Schema.Finite, output: Schema.Finite })

const Reject = Actor.command("Reject", { input: Schema.Finite, errors: [Rejected] })

const Nested = Actor.command("Nested")

const Escape = Actor.command("Escape")

const Hold = Actor.command("Hold")

const Steal = Actor.command("Steal")

const Counter = Actor.make("Counter", {
  id: Schema.String,
  commands: [Increment, Reject, Nested, Escape, Hold, Steal],
  state: { count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) },
})

let executions = 0

let captured: Effect.Effect<number, import("../../errors/actor.ts").ActorError> = Effect.succeed(0)

let escaped: Effect.Effect<void> = Effect.void

let holdHandler: Effect.Effect<void> = Effect.void

const CounterLive = Counter.toLayer({
  Increment: Effect.fnUntraced(function* (ctx, amount) {
    executions += 1
    yield* ctx.state.set({ count: ctx.state.count + amount })

    return ctx.state.count
  }),
  Reject: Effect.fnUntraced(function* (ctx, amount) {
    executions += 1
    yield* ctx.state.set({ count: 999 })

    return yield* Rejected.make({ amount })
  }),
  Nested: Effect.fnUntraced(function* (ctx) {
    yield* ctx.state.set({ count: 99 })
    yield* captured.pipe(Effect.orDie)
  }),
  Escape: Effect.fnUntraced(function* (ctx) {
    escaped = ctx.state.set({ count: 1000 })
    yield* ctx.state.set({ count: 3 })
  }),
  Hold: Effect.fnUntraced(function* (ctx) {
    escaped = ctx.state.set({ count: 1000 })
    yield* holdHandler
    yield* ctx.state.set({ count: 3 })
  }),
  Steal: () => Effect.suspend(() => escaped),
})

describe("Postgres durable turns", () => {
  const crypto = ManagedRuntime.make(BunCrypto.layer)
  let admin: Pool
  let name: string

  let runtime: ManagedRuntime.ManagedRuntime<
    Actors | ActorTest | SqlClient.SqlClient | Crypto.Crypto,
    never
  >

  let databaseUrl: string
  let allowed = true

  const start = (retryWindowMs = 60_000) =>
    ManagedRuntime.make(
      CounterLive.pipe(
        Layer.provideMerge(
          ActorTest.layer({
            database: Redacted.make(databaseUrl),
            as: User.make({ subject: "alice" }),
            authorize: () => Effect.sync(() => allowed),
            retryWindowMs,
          }),
        ),
        Layer.provideMerge(BunCrypto.layer),
        Layer.orDie,
      ),
    )

  beforeAll(
    () =>
      crypto.runPromise(
        Effect.gen(function* () {
          const url = yield* Config.String("TEST_DATABASE_URL")
          name = `actors_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`
          admin = new Pool({ connectionString: url })
          yield* Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`))
          const database = new URL(url)
          database.pathname = `/${name}`
          databaseUrl = database.href
          runtime = start()
          yield* Effect.promise(() => runtime.runPromise(Effect.void))
        }),
      ),
    30_000,
  )

  afterAll(() =>
    crypto
      .runPromise(
        Effect.gen(function* () {
          if (runtime !== undefined) yield* Effect.promise(() => runtime.dispose())

          if (admin !== undefined) {
            if (name !== undefined)
              yield* Effect.promise(() =>
                admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
              )
            yield* Effect.promise(() => admin.end())
          }
        }),
      )
      .finally(() => crypto.dispose()),
  )

  it("commits state and receipt, replays an identical command effect, and keeps its generation", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const counter = yield* Counter.get("replay")
        expect(yield* test.inspect(counter.ref)).toEqual({
          generation: undefined,
          state: {},
          receipts: 0,
        })
        const increment = counter.Increment(7)
        expect(yield* increment).toBe(7)
        expect(yield* increment).toBe(7)
        expect(yield* counter.Increment(3)).toBe(10)
        expect(yield* test.inspect(counter.ref)).toEqual({
          generation: "1",
          state: { count: 10 },
          receipts: 2,
        })
      }),
    ))

  it("rolls back declared failures and replays their class and payload without executing again", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const counter = yield* Counter.get("failure")
        expect(yield* counter.Increment(5)).toBe(5)
        const rejected = counter.Reject(13)
        const before = executions
        const first = yield* rejected.pipe(Effect.flip)
        expect(first).toBeInstanceOf(Rejected)
        expect(first).toEqual(Rejected.make({ amount: 13 }))
        expect(yield* rejected.pipe(Effect.flip)).toEqual(first)
        expect(executions - before).toBe(1)
        expect(yield* test.inspect(counter.ref)).toEqual({
          generation: "1",
          state: { count: 5 },
          receipts: 2,
        })
      }),
    ))

  it("deduplicates concurrent deliveries and rejects changed input or command", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const counter = yield* Counter.get("concurrent")
        const id = yield* (yield* Actors).mintCommandId
        const before = executions
        expect(
          yield* Effect.forEach(
            [counter.Increment(11), counter.Increment(11)],
            (call) => call.pipe(Actor.commandId(id)),
            { concurrency: 2 },
          ),
        ).toEqual([11, 11])
        expect(executions - before).toBe(1)
        expect(
          (yield* counter.Increment(12).pipe(Actor.commandId(id), Effect.flip)).reason._tag,
        ).toBe("CommandConflict")
        expect(yield* counter.Reject(11).pipe(Actor.commandId(id), Effect.flip)).toMatchObject({
          reason: CommandConflict.make({ commandId: id }),
        })
        expect(yield* test.inspect(counter.ref)).toMatchObject({
          state: { count: 11 },
          receipts: 1,
        })
      }),
    ))

  it("captures callers, preserves same-subject access, and never partitions deduplication by caller", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const alice = yield* Counter.get("privacy")
        const bob = yield* Counter.get("privacy", { as: User.make({ subject: "bob" }) })
        const id = yield* (yield* Actors).mintCommandId
        expect(
          yield* alice
            .Increment(17)
            .pipe(
              Actor.commandId(id),
              Effect.provideService(CurrentCaller, User.make({ subject: "bob" })),
            ),
        ).toBe(17)
        const rotated = yield* Counter.get("privacy", { as: User.make({ subject: "alice" }) })
        expect(yield* rotated.Increment(17).pipe(Actor.commandId(id))).toBe(17)
        expect(yield* bob.Increment(17).pipe(Actor.commandId(id), Effect.flip)).toMatchObject({
          reason: Unauthorized.make({ code: "receipt_access_denied" }),
        })

        const otherTenant = yield* Counter.get("privacy", {
          tenant: "other",
          as: User.make({ subject: "bob" }),
        })

        expect(yield* otherTenant.Increment(29).pipe(Actor.commandId(id))).toBe(29)
        expect(yield* test.inspect(alice.ref)).toMatchObject({ state: { count: 17 }, receipts: 1 })
      }),
    ))

  for (const point of ["beforeHandler", "beforeCommit", "afterCommit"] as const) {
    it(`recovers ${point} crashes with the same command and one committed transition`, () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get(`crash-${point}`)
          const before = executions
          yield* test.crashNext(point)
          expect(yield* counter.Increment(23)).toBe(23)
          expect(executions - before).toBe(point === "beforeCommit" ? 2 : 1)
          expect(yield* test.inspect(counter.ref)).toMatchObject({
            state: { count: 23 },
            receipts: 1,
          })
        }),
      ))
  }

  it("keeps uncommitted state invisible and does not cancel an accepted turn with its waiter", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const counter = yield* Counter.get("disconnect")
        const pause = yield* test.pauseNext("beforeCommit")
        const call = counter.Increment(31)
        const waiter = yield* call.pipe(Effect.forkChild)
        yield* pause.reached
        expect(yield* test.inspect(counter.ref)).toEqual({
          generation: undefined,
          state: {},
          receipts: 0,
        })
        yield* Fiber.interrupt(waiter)
        yield* pause.release
        expect(yield* call).toBe(31)
        expect(yield* test.inspect(counter.ref)).toMatchObject({
          state: { count: 31 },
          receipts: 1,
        })
      }),
    ))

  it("rejects a stale generation before rerunning the handler under new authority", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const counter = yield* Counter.get("stale")
        expect(yield* counter.Increment(5)).toBe(5)
        yield* test.invalidate(counter.ref)
        const before = executions
        expect(yield* counter.Increment(8)).toBe(13)
        expect(executions - before).toBe(1)
        expect(yield* test.inspect(counter.ref)).toEqual({
          generation: "3",
          state: { count: 13 },
          receipts: 2,
        })
      }),
    ))

  it("rolls back captured request/reply misuse and rejects escaped state capabilities", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const counter = yield* Counter.get("guard")
        captured = counter.Increment(100)
        const exit = yield* counter.Nested().pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
          "Request/reply inside a turn",
        )
        expect(yield* test.inspect(counter.ref)).toEqual({
          generation: undefined,
          state: {},
          receipts: 0,
        })
        yield* counter.Escape()
        const escapedExit = yield* escaped.pipe(Effect.exit)
        expect(Exit.isFailure(escapedExit) && Cause.pretty(escapedExit.cause)).toContain(
          "State capability escaped its turn",
        )
        expect(yield* test.inspect(counter.ref)).toMatchObject({ state: { count: 3 }, receipts: 1 })
      }),
    ))

  it("rejects a state setter from another still-active actor turn", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const owner = yield* Counter.get("capability-owner")
        const thief = yield* Counter.get("capability-thief")
        const test = yield* ActorTest
        const ready = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        holdHandler = Deferred.succeed(ready, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        )
        const holder = yield* owner.Hold().pipe(Effect.forkChild)
        yield* Deferred.await(ready)

        const stolen = yield* thief
          .Steal()
          .pipe(Effect.exit, Effect.ensuring(Deferred.succeed(release, undefined)))

        expect(Exit.isFailure(stolen) && Cause.pretty(stolen.cause)).toContain(
          "State capability escaped its turn",
        )
        yield* Fiber.join(holder)
        expect(yield* test.inspect(owner.ref)).toMatchObject({ state: { count: 3 }, receipts: 1 })
        expect(yield* test.inspect(thief.ref)).toEqual({
          generation: undefined,
          state: {},
          receipts: 0,
        })
      }),
    ))

  it("denies a competing caller while the original failure is still uncommitted", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const alice = yield* Counter.get("caller-race")
        const bob = yield* Counter.get("caller-race", { as: User.make({ subject: "bob" }) })
        const id = yield* (yield* Actors).mintCommandId
        const pause = yield* test.pauseNext("beforeCommit")
        const before = executions

        const original = yield* alice
          .Reject(71)
          .pipe(Actor.commandId(id), Effect.flip, Effect.forkChild)

        yield* pause.reached

        const competitor = yield* bob
          .Reject(71)
          .pipe(Actor.commandId(id), Effect.flip, Effect.forkChild)

        const sql = yield* SqlClient.SqlClient

        const entity = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
        )([alice.ref.tenant, alice.ref.id])

        yield* sql<{
          count: number
        }>`SELECT count(*)::int AS count FROM cluster_messages WHERE entity_id = ${entity} AND processed = false`.pipe(
          Effect.repeat({
            while: (rows) => rows[0]!.count !== 2,
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
          Effect.ensuring(pause.release),
        )
        expect(yield* Fiber.join(original)).toEqual(Rejected.make({ amount: 71 }))
        expect(yield* Fiber.join(competitor)).toMatchObject({
          reason: Unauthorized.make({ code: "receipt_access_denied" }),
        })
        expect(executions - before).toBe(1)
        expect(yield* test.inspect(alice.ref)).toMatchObject({ state: {}, receipts: 1 })
      }),
    ))

  it("refuses to reinterpret retained identities under a changed retry window", () =>
    crypto.runPromise(
      Effect.gen(function* () {
        const incompatible = yield* Effect.acquireRelease(
          Effect.sync(() => start(60_001)),
          (other) => Effect.promise(() => other.dispose()),
        )

        const exit = yield* Effect.promise(() => incompatible.runPromiseExit(Effect.void))
        expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
          "differs from the deployment",
        )
      }).pipe(Effect.scoped),
    ))

  it("revokes external access without canceling persisted work or trusted redelivery", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const counter = yield* Counter.get("revoked")
        const id = yield* (yield* Actors).mintCommandId
        const pause = yield* test.pauseNext("beforeHandler")
        yield* test.crashNext("beforeCommit")
        const call = counter.Increment(37).pipe(Actor.commandId(id))
        const waiter = yield* call.pipe(Effect.result, Effect.forkChild)
        yield* pause.reached
        allowed = false
        yield* pause.release
        const result = yield* Fiber.join(waiter)
        expect(result).toMatchObject({
          failure: { reason: Unauthorized.make({ code: "access_denied" }) },
        })
        expect(yield* test.inspect(counter.ref)).toMatchObject({
          state: { count: 37 },
          receipts: 1,
        })
        expect(yield* counter.Increment(1).pipe(Effect.flip)).toMatchObject({
          reason: Unauthorized.make({ code: "access_denied" }),
        })
        expect(yield* call.pipe(Effect.flip)).toMatchObject({
          reason: Unauthorized.make({ code: "access_denied" }),
        })
        allowed = true
        expect(yield* call).toBe(37)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            allowed = true
          }),
        ),
      ),
    ))

  it("defines exact expiry boundaries and rejects invalid/future identities", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const id = "v1.1000.6000.17b3670b-3f17-4a9b-aade-037e1dd1bba8"
        yield* checkIdentity(id, 5000, 5999)

        for (const now of [6000, 6001])
          expect(yield* checkIdentity(id, 5000, now).pipe(Effect.flip)).toMatchObject({
            reason: CommandExpired.make({ commandId: id }),
          })
        expect(yield* checkIdentity(id, 5000, 999).pipe(Effect.flip)).toMatchObject({
          reason: InvalidCommandId.make({ commandId: id }),
        })
        expect(
          yield* checkIdentity(id.replace("6000", "7000"), 5000, 1000).pipe(Effect.flip),
        ).toMatchObject({
          reason: InvalidCommandId.make({ commandId: id.replace("6000", "7000") }),
        })
        const counter = yield* Counter.get("expiry-first")
        const before = executions
        const expired = id.replace("6000", "61000")
        expect(
          yield* counter.Increment(41).pipe(Actor.commandId(expired), Effect.flip),
        ).toMatchObject({
          reason: CommandExpired.make({ commandId: expired }),
        })
        expect(executions).toBe(before)
      }),
    ))

  it("canonicalizes object keys but preserves array order in payload hashes", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const first = yield* payloadHash('{"value":{"b":2,"a":[3,7]}}')
        expect(yield* payloadHash('{"value":{"a":[3,7],"b":2}}')).toBe(first)
        expect(yield* payloadHash('{"value":{"a":[7,3],"b":2}}')).not.toBe(first)
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT 128::regclass AS value`).toEqual([{ value: 128 }])
      }),
    ))

  for (const point of ["beforeCommit", "afterCommit"] as const) {
    it(`recovers a declared failure ${point} without persisting dirty state`, () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get(`failure-${point}`)
          yield* counter.Increment(19)
          const before = executions
          const call = counter.Reject(53)
          yield* test.crashNext(point)
          expect(yield* call.pipe(Effect.flip)).toEqual(Rejected.make({ amount: 53 }))
          expect(executions - before).toBe(point === "beforeCommit" ? 2 : 1)
          expect(yield* test.inspect(counter.ref)).toMatchObject({
            state: { count: 19 },
            receipts: 2,
          })
          yield* counter.Increment(2)
          expect(yield* call.pipe(Effect.flip)).toEqual(Rejected.make({ amount: 53 }))
          expect(yield* test.inspect(counter.ref)).toMatchObject({
            state: { count: 21 },
            receipts: 3,
          })
        }),
      ))
  }

  it("retries a real generation lock timeout without entering the handler", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const counter = yield* Counter.get("locked")
        const test = yield* ActorTest
        yield* counter.Increment(2)

        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: databaseUrl })),
          (db) => Effect.promise(() => db.end()),
        )

        const lock = yield* Effect.acquireRelease(
          Effect.promise(() => pool.connect()),
          (client) =>
            Effect.promise(() => client.query("ROLLBACK")).pipe(
              Effect.andThen(Effect.sync(() => client.release())),
            ),
        )

        yield* Effect.promise(() => lock.query("BEGIN"))
        yield* Effect.promise(() =>
          lock.query(
            "SELECT generation FROM actor_generations WHERE tenant_id = $1 AND actor_type = $2 AND actor_id = $3 FOR UPDATE",
            [counter.ref.tenant, counter.ref.actor, counter.ref.id],
          ),
        )
        const before = executions
        const waiter = yield* counter.Increment(59).pipe(Effect.forkChild)
        yield* Effect.sleep("2300 millis")
        expect(executions).toBe(before)
        expect(yield* test.inspect(counter.ref)).toMatchObject({ state: { count: 2 }, receipts: 1 })
        yield* Effect.promise(() => lock.query("COMMIT"))
        expect(yield* Fiber.join(waiter)).toBe(61)
        expect(executions - before).toBe(1)
        expect(yield* test.inspect(counter.ref)).toMatchObject({
          state: { count: 61 },
          receipts: 2,
        })
      }).pipe(Effect.scoped),
    ))

  it("completes trusted redelivery after expiry but refuses the external outcome", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const counter = yield* Counter.get("expired-pending")
        const test = yield* ActorTest
        const pause = yield* test.pauseNext("beforeHandler")
        yield* test.crashNext("beforeCommit")
        const now = yield* databaseTime
        const id = `v1.${now - 59_500}.${now + 500}.17b3670b-3f17-4a9b-aade-037e1dd1bba8`

        const waiter = yield* counter
          .Increment(67)
          .pipe(Actor.commandId(id), Effect.flip, Effect.forkChild)

        yield* pause.reached
        yield* Effect.sleep("550 millis")
        yield* pause.release
        expect(yield* Fiber.join(waiter)).toMatchObject({
          reason: CommandExpired.make({ commandId: id }),
        })
        expect(yield* test.inspect(counter.ref)).toMatchObject({
          state: { count: 67 },
          receipts: 1,
        })
      }),
    ))

  it("rejects an expired identity after receipt pruning and runtime restart", () =>
    crypto.runPromise(
      Effect.gen(function* () {
        const saved = yield* Effect.promise(() =>
          runtime.runPromise(
            Effect.gen(function* () {
              const counter = yield* Counter.get("restart")
              const now = yield* databaseTime
              const id = `v1.${now - 59_500}.${now + 500}.17b3670b-3f17-4a9b-aade-037e1dd1bba8`
              expect(yield* counter.Increment(43).pipe(Actor.commandId(id))).toBe(43)
              const sql = yield* SqlClient.SqlClient
              yield* Effect.sleep("550 millis")
              yield* sql`DELETE FROM actor_receipts WHERE tenant_id = ${counter.ref.tenant} AND actor_type = ${counter.ref.actor} AND actor_id = ${counter.ref.id}`

              return { ref: counter.ref, id }
            }),
          ),
        )

        yield* Effect.promise(() => runtime.dispose())
        runtime = start()
        yield* Effect.promise(() =>
          runtime.runPromise(
            Effect.gen(function* () {
              const counter = yield* Counter.get(saved.ref.id, { tenant: saved.ref.tenant })
              expect(
                yield* counter.Increment(43).pipe(Actor.commandId(saved.id), Effect.flip),
              ).toMatchObject({ reason: CommandExpired.make({ commandId: saved.id }) })
              const test = yield* ActorTest
              expect(yield* test.inspect(counter.ref)).toMatchObject({
                state: { count: 43 },
                receipts: 0,
              })
              expect(yield* counter.Increment(2)).toBe(45)
            }),
          ),
        )
      }),
    ))
})
