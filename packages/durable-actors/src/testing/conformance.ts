import {
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Schedule,
  Schema,
  Scope,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors, CurrentCaller, User } from "../index.ts"
import { CommandConflict, CommandExpired, InvalidCommandId, Unauthorized } from "../errors/actor.ts"
import { checkIdentity, databaseTime } from "../runtime/turn/admission.ts"
import { payloadHash } from "../runtime/turn/receipt.ts"
import { ActorTest } from "./actor-test.ts"
import {
  foundationConformance,
  foundationFixture,
  foundationLayer,
  type FoundationFixture,
} from "./foundation.ts"

/**
 * Assertions injected by the test framework running the suite, e.g. Vitest's
 * `expect`. The framework itself is never imported here.
 */
export interface ConformanceMatchers {
  readonly not: ConformanceMatchers
  readonly toBe: <T>(expected: T) => void
  readonly toEqual: <T>(expected: T) => void
  readonly toContain: <T>(expected: T) => void
  readonly toMatchObject: <T extends object | ReadonlyArray<unknown>>(expected: T) => void
  readonly toBeInstanceOf: <T>(expected: T) => void
}

export type ConformanceExpect = <T>(actual: T) => ConformanceMatchers

/**
 * The subset of `describe`/`it`/lifecycle a registrar must supply. Vitest's
 * exported functions satisfy this shape.
 */
export interface ConformanceRegistrar {
  readonly describe: (name: string, body: () => void) => void
  readonly it: (name: string, body: () => Promise<void>, timeout?: number) => void
  readonly beforeAll: (body: () => Promise<void> | void, timeout?: number) => void
  readonly afterAll: (body: () => Promise<void> | void) => void
  readonly expect: ConformanceExpect
  /** Registers an inapplicable case by name so it is reported, never silently dropped. */
  readonly skip: (name: string) => void
}

export type ConformanceDatabase = NonNullable<Parameters<typeof ActorTest.layer>[0]["database"]>

export interface ConformanceConnection {
  readonly query: (
    statement: string,
    parameters?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<unknown>>
}

/** Services every `environment.run` effect may require; Scope is provided. */
export type ConformanceServices = Actors | ActorTest | SqlClient.SqlClient | Crypto.Crypto

export type ConformanceRuntime = ManagedRuntime.ManagedRuntime<ConformanceServices, never>

export interface ConformanceEnvironment {
  /** Runs an effect against the current runtime. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, ConformanceServices | Scope.Scope>) => Promise<A>
  /** Builds a new runtime without installing it; warm it explicitly. */
  readonly build: (options?: {
    readonly retryWindowMs?: number
    readonly database?: ConformanceDatabase
  }) => ConformanceRuntime
  /** Stops the current runtime; the retained database survives. */
  readonly stop: Effect.Effect<void>
  /** Restarts the current runtime against the retained database. */
  readonly restart: Effect.Effect<void>
  /** A second database untouched by the current runtime, for isolation cases. */
  readonly freshDatabase: Effect.Effect<ConformanceDatabase>
  /**
   * Opens an independent SQL connection to the same database. Only present
   * when the backend advertises `independentConnections`.
   */
  readonly connect?: Effect.Effect<ConformanceConnection, never, Scope.Scope>
}

export interface ConformanceBackend {
  /** True when the backend can open concurrent SQL connections (real Postgres). */
  readonly independentConnections: boolean
  /** Extra services merged into every test runtime, e.g. BunCrypto.layer. */
  readonly services: Layer.Layer<Crypto.Crypto, never, never>
  readonly open: () => Promise<{
    readonly database: ConformanceDatabase
    readonly freshDatabase: Effect.Effect<ConformanceDatabase>
    readonly connect?: Effect.Effect<ConformanceConnection, never, Scope.Scope>
    readonly close: Effect.Effect<void>
  }>
}

/** Mutable per-suite fixture shared by the fixture handlers and the cases. */
export interface ConformanceFixture {
  readonly foundation: FoundationFixture
  executions: number
  captured: Effect.Effect<number, import("../errors/actor.ts").ActorError>
  escaped: Effect.Effect<void>
  holdHandler: Effect.Effect<void>
  allowed: boolean
}

export interface ConformanceContext {
  readonly expect: ConformanceExpect
  readonly environment: ConformanceEnvironment
  readonly fixture: ConformanceFixture
}

export interface ConformanceCase {
  readonly name: string
  /**
   * Requires `backend.independentConnections`; backends without it register
   * the case through `registrar.skip` instead of running it.
   */
  readonly requiresIndependentConnections?: boolean
  readonly run: (ctx: ConformanceContext) => Promise<void>
  readonly timeoutMs?: number
}

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

const CounterLive = (fixture: ConformanceFixture) =>
  Counter.toLayer({
    Increment: Effect.fnUntraced(function* (ctx, amount) {
      fixture.executions += 1
      yield* ctx.state.set({ count: ctx.state.count + amount })

      return ctx.state.count
    }),
    Reject: Effect.fnUntraced(function* (ctx, amount) {
      fixture.executions += 1
      yield* ctx.state.set({ count: 999 })

      return yield* Rejected.make({ amount })
    }),
    Nested: Effect.fnUntraced(function* (ctx) {
      yield* ctx.state.set({ count: 99 })
      yield* fixture.captured.pipe(Effect.orDie)
    }),
    Escape: Effect.fnUntraced(function* (ctx) {
      fixture.escaped = ctx.state.set({ count: 1000 })
      yield* ctx.state.set({ count: 3 })
    }),
    Hold: Effect.fnUntraced(function* (ctx) {
      fixture.escaped = ctx.state.set({ count: 1000 })
      yield* fixture.holdHandler
      yield* ctx.state.set({ count: 3 })
    }),
    Steal: () => Effect.suspend(() => fixture.escaped),
  })

const makeFixture = (): ConformanceFixture => ({
  foundation: foundationFixture(),
  executions: 0,
  captured: Effect.succeed(0),
  escaped: Effect.void,
  holdHandler: Effect.void,
  allowed: true,
})

/**
 * The shared durable-turn conformance cases. Cases flagged
 * `requiresIndependentConnections` need a real second database connection —
 * either to read committed state while a turn holds its transaction open, or
 * to take a competing row lock — and never run on single-connection backends
 * such as PGlite.
 */
export const conformance: ReadonlyArray<ConformanceCase> = [
  ...foundationConformance,
  {
    name: "commits state and receipt, replays an identical command effect, and keeps its generation",
    run: ({ expect, environment }) =>
      environment.run(
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
      ),
  },
  {
    name: "rolls back declared failures and replays their class and payload without executing again",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get("failure")
          expect(yield* counter.Increment(5)).toBe(5)
          const rejected = counter.Reject(13)
          const before = fixture.executions
          const first = yield* rejected.pipe(Effect.flip)
          expect(first).toBeInstanceOf(Rejected)
          expect(first).toEqual(Rejected.make({ amount: 13 }))
          expect(yield* rejected.pipe(Effect.flip)).toEqual(first)
          expect(fixture.executions - before).toBe(1)
          expect(yield* test.inspect(counter.ref)).toEqual({
            generation: "1",
            state: { count: 5 },
            receipts: 2,
          })
        }),
      ),
  },
  {
    name: "deduplicates concurrent deliveries and rejects changed input or command",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get("concurrent")
          const id = yield* (yield* Actors).mintCommandId
          const before = fixture.executions
          expect(
            yield* Effect.forEach(
              [counter.Increment(11), counter.Increment(11)],
              (call) => call.pipe(Actor.commandId(id)),
              { concurrency: 2 },
            ),
          ).toEqual([11, 11])
          expect(fixture.executions - before).toBe(1)
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
      ),
  },
  {
    name: "captures callers, preserves same-subject access, and never partitions deduplication by caller",
    run: ({ expect, environment }) =>
      environment.run(
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
          expect(yield* test.inspect(alice.ref)).toMatchObject({
            state: { count: 17 },
            receipts: 1,
          })
        }),
      ),
  },
  {
    name: "recovers beforeHandler crashes with the same command and one committed transition",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get("crash-beforeHandler")
          const before = fixture.executions
          yield* test.crashNext("beforeHandler")
          expect(yield* counter.Increment(23)).toBe(23)
          expect(fixture.executions - before).toBe(1)
          expect(yield* test.inspect(counter.ref)).toMatchObject({
            state: { count: 23 },
            receipts: 1,
          })
        }),
      ),
  },
  {
    name: "recovers beforeCommit crashes with the same command and one committed transition",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get("crash-beforeCommit")
          const before = fixture.executions
          yield* test.crashNext("beforeCommit")
          expect(yield* counter.Increment(23)).toBe(23)
          expect(fixture.executions - before).toBe(2)
          expect(yield* test.inspect(counter.ref)).toMatchObject({
            state: { count: 23 },
            receipts: 1,
          })
        }),
      ),
  },
  {
    name: "recovers afterCommit crashes with the same command and one committed transition",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get("crash-afterCommit")
          const before = fixture.executions
          yield* test.crashNext("afterCommit")
          expect(yield* counter.Increment(23)).toBe(23)
          expect(fixture.executions - before).toBe(1)
          expect(yield* test.inspect(counter.ref)).toMatchObject({
            state: { count: 23 },
            receipts: 1,
          })
        }),
      ),
  },
  {
    name: "does not cancel an accepted turn with its waiter",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get("disconnect")
          const pause = yield* test.pauseNext("beforeCommit")
          const call = counter.Increment(31)
          const waiter = yield* call.pipe(Effect.forkChild)
          yield* pause.reached
          yield* Fiber.interrupt(waiter)
          yield* pause.release
          expect(yield* call).toBe(31)
          expect(yield* test.inspect(counter.ref)).toMatchObject({
            state: { count: 31 },
            receipts: 1,
          })
        }),
      ),
  },
  {
    name: "keeps uncommitted state invisible to a second connection",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get("disconnect-visibility")
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
      ),
  },
  {
    name: "rejects a stale generation before rerunning the handler under new authority",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get("stale")
          expect(yield* counter.Increment(5)).toBe(5)
          yield* test.invalidate(counter.ref)
          const before = fixture.executions
          expect(yield* counter.Increment(8)).toBe(13)
          expect(fixture.executions - before).toBe(1)
          expect(yield* test.inspect(counter.ref)).toEqual({
            generation: "3",
            state: { count: 13 },
            receipts: 2,
          })
        }),
      ),
  },
  {
    name: "rolls back captured request/reply misuse and rejects escaped state capabilities",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get("guard")
          fixture.captured = counter.Increment(100)
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
          const escapedExit = yield* fixture.escaped.pipe(Effect.exit)
          expect(Exit.isFailure(escapedExit) && Cause.pretty(escapedExit.cause)).toContain(
            "State capability escaped its turn",
          )
          expect(yield* test.inspect(counter.ref)).toMatchObject({
            state: { count: 3 },
            receipts: 1,
          })
        }),
      ),
  },
  {
    name: "rejects a state setter from another still-active actor turn",
    requiresIndependentConnections: true,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const owner = yield* Counter.get("capability-owner")
          const thief = yield* Counter.get("capability-thief")
          const test = yield* ActorTest
          const ready = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          fixture.holdHandler = Deferred.succeed(ready, undefined).pipe(
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
          expect(yield* test.inspect(owner.ref)).toMatchObject({
            state: { count: 3 },
            receipts: 1,
          })
          expect(yield* test.inspect(thief.ref)).toEqual({
            generation: undefined,
            state: {},
            receipts: 0,
          })
        }),
      ),
  },
  {
    name: "denies a competing caller while the original failure is still uncommitted",
    requiresIndependentConnections: true,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const alice = yield* Counter.get("caller-race")
          const bob = yield* Counter.get("caller-race", { as: User.make({ subject: "bob" }) })
          const id = yield* (yield* Actors).mintCommandId
          const pause = yield* test.pauseNext("beforeCommit")
          const before = fixture.executions

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
          expect(fixture.executions - before).toBe(1)
          expect(yield* test.inspect(alice.ref)).toMatchObject({ state: {}, receipts: 1 })
        }),
      ),
  },
  {
    name: "refuses to reinterpret retained identities under a changed retry window",
    run: ({ expect, environment }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* environment.stop
          const incompatible = environment.build({ retryWindowMs: 60_001 })
          const exit = yield* Effect.promise(() => incompatible.runPromiseExit(Effect.void))
          yield* Effect.promise(() => incompatible.dispose())
          yield* environment.restart
          expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
            "differs from the deployment",
          )
        }),
      ),
  },
  {
    name: "revokes external access without canceling persisted work or trusted redelivery",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get("revoked")
          const id = yield* (yield* Actors).mintCommandId
          const pause = yield* test.pauseNext("beforeHandler")
          yield* test.crashNext("beforeCommit")
          const call = counter.Increment(37).pipe(Actor.commandId(id))
          const waiter = yield* call.pipe(Effect.result, Effect.forkChild)
          yield* pause.reached
          fixture.allowed = false
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
          fixture.allowed = true
          expect(yield* call).toBe(37)
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              fixture.allowed = true
            }),
          ),
        ),
      ),
  },
  {
    name: "defines exact expiry boundaries and rejects invalid/future identities",
    run: ({ expect, environment, fixture }) =>
      environment.run(
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
          const before = fixture.executions
          const expired = id.replace("6000", "61000")
          expect(
            yield* counter.Increment(41).pipe(Actor.commandId(expired), Effect.flip),
          ).toMatchObject({
            reason: CommandExpired.make({ commandId: expired }),
          })
          expect(fixture.executions).toBe(before)
        }),
      ),
  },
  {
    name: "canonicalizes object keys but preserves array order in payload hashes",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const first = yield* payloadHash('{"value":{"b":2,"a":[3,7]}}')
          expect(yield* payloadHash('{"value":{"a":[3,7],"b":2}}')).toBe(first)
          expect(yield* payloadHash('{"value":{"a":[7,3],"b":2}}')).not.toBe(first)
        }),
      ),
  },
  {
    name: "decodes regclass so the migrator can reopen the database",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          expect(yield* sql`SELECT 128::regclass AS value`).toEqual([{ value: 128 }])
        }),
      ),
  },
  {
    name: "recovers a declared failure beforeCommit without persisting dirty state",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get("failure-beforeCommit")
          yield* counter.Increment(19)
          const before = fixture.executions
          const call = counter.Reject(53)
          yield* test.crashNext("beforeCommit")
          expect(yield* call.pipe(Effect.flip)).toEqual(Rejected.make({ amount: 53 }))
          expect(fixture.executions - before).toBe(2)
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
      ),
  },
  {
    name: "recovers a declared failure afterCommit without persisting dirty state",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const counter = yield* Counter.get("failure-afterCommit")
          yield* counter.Increment(19)
          const before = fixture.executions
          const call = counter.Reject(53)
          yield* test.crashNext("afterCommit")
          expect(yield* call.pipe(Effect.flip)).toEqual(Rejected.make({ amount: 53 }))
          expect(fixture.executions - before).toBe(1)
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
      ),
  },
  {
    name: "retries a real generation lock timeout without entering the handler",
    requiresIndependentConnections: true,
    timeoutMs: 15_000,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const counter = yield* Counter.get("locked")
          const test = yield* ActorTest
          yield* counter.Increment(2)

          const connect = environment.connect

          if (connect === undefined)
            return yield* Effect.die(new Error("backend lacks independent connections"))

          const lock = yield* connect
          yield* lock.query("BEGIN")
          yield* lock.query(
            "SELECT generation FROM actor_generations WHERE tenant_id = $1 AND actor_type = $2 AND actor_id = $3 FOR UPDATE",
            [counter.ref.tenant, counter.ref.actor, counter.ref.id],
          )
          const before = fixture.executions
          const waiter = yield* counter.Increment(59).pipe(Effect.forkChild)
          yield* Effect.sleep("2300 millis")
          expect(fixture.executions).toBe(before)
          expect(yield* test.inspect(counter.ref)).toMatchObject({
            state: { count: 2 },
            receipts: 1,
          })
          yield* lock.query("COMMIT")
          expect(yield* Fiber.join(waiter)).toBe(61)
          expect(fixture.executions - before).toBe(1)
          expect(yield* test.inspect(counter.ref)).toMatchObject({
            state: { count: 61 },
            receipts: 2,
          })
        }),
      ),
  },
  {
    name: "completes trusted redelivery after expiry but refuses the external outcome",
    run: ({ expect, environment }) =>
      environment.run(
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
      ),
  },
  {
    name: "rejects an expired identity after receipt pruning and runtime restart",
    run: ({ expect, environment }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const saved = yield* Effect.promise(() =>
            environment.run(
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

          yield* environment.restart

          yield* Effect.promise(() =>
            environment.run(
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
      ),
  },
  {
    name: "isolates durable state between fresh layer builds",
    run: ({ expect, environment }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const tenant = yield* Effect.promise(() =>
            environment.run(
              Effect.gen(function* () {
                const counter = yield* Counter.get("isolated")
                expect(yield* counter.Increment(4)).toBe(4)
                const test = yield* ActorTest

                return test.tenant
              }),
            ),
          )

          const database = yield* environment.freshDatabase

          const isolated = yield* Effect.acquireRelease(
            Effect.sync(() => environment.build({ database })),
            (runtime) => Effect.promise(() => runtime.dispose()),
          )

          yield* Effect.promise(() =>
            isolated.runPromise(
              Effect.gen(function* () {
                const counter = yield* Counter.get("isolated", { tenant })
                const test = yield* ActorTest
                expect(yield* test.inspect(counter.ref)).toEqual({
                  generation: undefined,
                  state: {},
                  receipts: 0,
                })
                expect(yield* counter.Increment(6)).toBe(6)
                expect(yield* test.inspect(counter.ref)).toMatchObject({
                  state: { count: 6 },
                  receipts: 1,
                })
              }),
            ),
          )

          yield* Effect.promise(() =>
            environment.run(
              Effect.gen(function* () {
                const counter = yield* Counter.get("isolated", { tenant })
                const test = yield* ActorTest
                expect(yield* test.inspect(counter.ref)).toMatchObject({
                  state: { count: 4 },
                  receipts: 1,
                })
              }),
            ),
          )
        }).pipe(Effect.scoped),
      ),
  },
]

interface ConformanceStore {
  readonly database: ConformanceDatabase
  readonly freshDatabase: Effect.Effect<ConformanceDatabase>
  readonly connect?: Effect.Effect<ConformanceConnection, never, Scope.Scope>
  readonly close: Effect.Effect<void>
}

/**
 * Registers every named conformance case against `backend`. The same case
 * names run on every backend; cases that need independent SQL connections are
 * reported through `registrar.skip` when the backend cannot provide them.
 */
export const describeConformance = (options: {
  readonly name: string
  readonly backend: ConformanceBackend
  readonly registrar: ConformanceRegistrar
}): void => {
  const { name, backend, registrar } = options
  const fixture = makeFixture()
  const live = Layer.mergeAll(CounterLive(fixture), foundationLayer(fixture.foundation))

  let store: ConformanceStore | undefined

  let current: ConformanceRuntime | undefined

  const environment: ConformanceEnvironment = {
    run: (effect) => {
      if (current === undefined)
        return Promise.reject(new Error("Conformance environment is stopped"))

      return current.runPromise(Effect.scoped(effect))
    },
    build: (overrides) => {
      const database = overrides?.database ?? store?.database

      if (database === undefined) throw new Error("Conformance environment is not open")

      return ManagedRuntime.make(
        live.pipe(
          Layer.provideMerge(
            ActorTest.layer({
              database,
              as: User.make({ subject: "alice" }),
              authorize: () => Effect.sync(() => fixture.allowed),
              retryWindowMs: overrides?.retryWindowMs ?? 60_000,
            }),
          ),
          Layer.provideMerge(backend.services),
          Layer.orDie,
        ),
      )
    },
    stop: Effect.suspend(() => {
      const previous = current
      current = undefined

      return previous === undefined ? Effect.void : Effect.promise(() => previous.dispose())
    }),
    restart: Effect.suspend(() =>
      Effect.andThen(environment.stop, () =>
        Effect.promise(() => {
          current = environment.build()

          return current.runPromise(Effect.void)
        }),
      ),
    ),
    freshDatabase: Effect.suspend(() =>
      store === undefined
        ? Effect.die(new Error("Conformance environment is not open"))
        : store.freshDatabase,
    ),
    get connect() {
      return store?.connect
    },
  }

  registrar.describe(name, () => {
    registrar.beforeAll(
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            store = yield* Effect.promise(() => backend.open())
            yield* environment.restart
          }),
        ),
      30_000,
    )

    registrar.afterAll(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* environment.stop

          if (store !== undefined) yield* store.close

          store = undefined
        }),
      ),
    )

    for (const conformanceCase of conformance) {
      if (
        conformanceCase.requiresIndependentConnections === true &&
        backend.independentConnections === false
      ) {
        registrar.skip(conformanceCase.name)
        continue
      }

      registrar.it(
        conformanceCase.name,
        () => conformanceCase.run({ expect: registrar.expect, environment, fixture }),
        conformanceCase.timeoutMs,
      )
    }
  })
}
