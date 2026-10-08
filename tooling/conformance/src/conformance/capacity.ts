import {
  Clock,
  Context,
  Crypto,
  Deferred,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schema,
  Scope,
} from "effect"
import {
  Actor,
  ActorError,
  Actors,
  CommandExpired,
  MailboxFull,
  RunnerAtCapacity,
} from "../../../../packages/akter/src/index.ts"
import { commandTimes } from "../../../../packages/akter/src/identity/command.ts"
import { ACTIVATION_MAILBOX } from "../../../../packages/akter/src/runtime/entity/register.ts"
import type { Request } from "../../../../packages/akter/src/runtime/request.ts"
import { TurnConnections } from "../../../../packages/akter/src/runtime/turn/pipeline.ts"
import { TurnHooks, type TurnPoint } from "../../../../packages/akter/src/runtime/turn/hooks.ts"
import { ActorTest, type TestOptions } from "../../../../packages/akter/src/testing/actor-test.ts"
import { clusterLayer, ActorCluster } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"

const Touch = Actor.command("Touch", { success: Schema.Finite })

const Hold = Actor.command("Hold")

let hold: Effect.Effect<void> = Effect.void

const count = Actor.state({
  count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

const Unbounded = Actor.make("CapacityUnbounded", {
  key: Schema.NonEmptyString,
  state: count,
  api: { Touch },
  policy: { deliveryTimeout: "5 seconds" },
})

const Bounded = Actor.make("CapacityBounded", {
  key: Schema.NonEmptyString,
  state: count,
  api: { Touch, Hold },
  policy: { deliveryTimeout: "5 seconds", mailboxCapacity: 1 },
})

const Sleepy = Actor.make("CapacitySleepy", {
  key: Schema.NonEmptyString,
  state: count,
  api: { Touch },
  policy: { deliveryTimeout: "20 seconds", hibernateAfter: "1 second" },
})

const Hot = Actor.make("CapacityHot", {
  key: Schema.NonEmptyString,
  state: count,
  api: { Touch },
  policy: { deliveryTimeout: "30 seconds" },
})

const WarmUp = Actor.make("CapacityWarmUp", { key: Schema.NonEmptyString, api: { Touch } })

const Patient = Actor.make("CapacityPatient", { key: Schema.NonEmptyString, api: { Touch } })

const Quick = Actor.make("CapacityQuick", {
  key: Schema.NonEmptyString,
  api: { Touch },
  policy: { deliveryTimeout: "20 seconds", hibernateAfter: "1 second" },
})

/**
 * `Patient` comes first, so its type, with the default 60-second
 * `hibernateAfter`, registers before `Quick`'s one second.
 */
const HibernationLive = Layer.mergeAll(
  Patient.toLayer(Effect.succeed({ Touch: () => Effect.succeed(0) })),
  Quick.toLayer(Effect.succeed({ Touch: () => Effect.succeed(0) })),
)

/** The longest an idle activation may outlive its `hibernateAfter`: the idle sweep runs every 5 seconds. */
const SWEEP_MS = 5_000

/**
 * How long a command or shutdown may take to settle once the runtime closes.
 * A caller that waits on a reply nobody completes would block until this
 * bound, so the bound is what turns that hang into a failed assertion.
 */
const SHUTDOWN_BOUND = "3 seconds"

const CapacityLive = Layer.mergeAll(
  Sleepy.toLayer(
    Effect.succeed({
      Touch: Effect.fnUntraced(function* () {
        const turn = yield* Sleepy.Turn
        yield* turn.state.set({ count: turn.state.count + 1 })

        return turn.state.count
      }),
    }),
  ),
  Unbounded.toLayer(
    Effect.succeed({
      Touch: Effect.fnUntraced(function* () {
        const turn = yield* Unbounded.Turn
        yield* turn.state.set({ count: turn.state.count + 1 })

        return turn.state.count
      }),
    }),
  ),
  Bounded.toLayer(
    Effect.succeed({
      Touch: Effect.fnUntraced(function* () {
        const turn = yield* Bounded.Turn
        yield* turn.state.set({ count: turn.state.count + 1 })

        return turn.state.count
      }),
      Hold: () => Effect.suspend(() => hold),
    }),
  ),
  Hot.toLayer(
    Effect.succeed({
      Touch: Effect.fnUntraced(function* () {
        const turn = yield* Hot.Turn
        yield* turn.state.set({ count: turn.state.count + 1 })

        return turn.state.count
      }),
    }),
  ),
  WarmUp.toLayer(Effect.succeed({ Touch: () => Effect.succeed(0) })),
)

/**
 * A runtime of its own on a fresh database, so only these actors hold resident
 * slots. A runner on Postgres takes seconds to acquire its shards, so one
 * warm-up command with a long delivery timeout runs first, in a slot of its own.
 */
const withCapacity = <A, E>(
  environment: ConformanceEnvironment,
  limits: {
    readonly maxResidentActors: number
    readonly admission?: TestOptions["admission"]
    readonly at?: (point: TurnPoint, request: Request) => Effect.Effect<void>
  },
  body: Effect.Effect<A, E, Actors | ActorTest | Scope.Scope>,
) =>
  environment.run(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      const database = yield* environment.freshDatabase

      const services = yield* Layer.build(
        Layer.fresh(
          CapacityLive.pipe(
            Layer.provideMerge(
              ActorTest.layer({
                database,
                maxResidentActors: limits.maxResidentActors + 1,
                admission: limits.admission,
              }).pipe(
                Layer.provide(Layer.succeed(TurnHooks, { at: limits.at ?? (() => Effect.void) })),
              ),
            ),
            Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
            Layer.orDie,
          ),
        ),
      )

      return yield* WarmUp.get("warm-up").pipe(
        Effect.flatMap((actor) => actor.Touch()),
        Effect.andThen(body),
        Effect.provideContext(services),
      )
    }),
  )

const reasonOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "success"
  const error = Exit.findErrorOption(exit)

  return Option.isSome(error) && Schema.is(ActorError)(error.value)
    ? error.value.reason._tag
    : "other"
}

/**
 * Capacity cases: a caller over capacity gets `RunnerAtCapacity` after
 * `deliveryTimeout`, a resident bounded actor with a full mailbox reports
 * `MailboxFull`, and a full runner or default-bounded activation refuses at
 * once with `ActorUnavailable`.
 */
export const capacityConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "a capacity-rejected command that expires before its first admission never runs or writes a receipt",
    timeoutMs: 30_000,
    run: ({ environment, expect }) =>
      withCapacity(
        environment,
        { maxResidentActors: 1 },
        Effect.gen(function* () {
          const test = yield* ActorTest
          const resident = yield* Sleepy.get("expiry-resident")
          const waiting = yield* Sleepy.get("expiry-waiting")
          expect(yield* resident.Touch()).toBe(1)
          const minted = commandTimes(yield* (yield* Actors).mintCommandId)
          const now = DateTime.toEpochMillis(yield* test.now)
          const id = `v1.${now + 500 - (minted.expiresAt - minted.issuedAt)}.${now + 500}.d1a434bc-10c3-444a-8c76-223f6169c958`
          const holding = yield* test.pauseNext("beforeCommit")
          const occupied = yield* resident.Touch().pipe(Effect.forkChild)
          yield* holding.reached

          const call = yield* waiting
            .Touch()
            .pipe(Actor.commandId(id), Effect.flip, Effect.forkChild)
          yield* Effect.sleep("800 millis")
          yield* holding.release
          expect(yield* Fiber.join(occupied)).toBe(2)
          expect((yield* Fiber.join(call)).reason).toEqual(CommandExpired.make({ commandId: id }))
          const inspected = yield* test.inspect(waiting.ref)
          expect(inspected.receipts).toBe(0)
          expect(inspected.state).toEqual({})
        }),
      ),
  },
  {
    name: "over-capacity load on an unbounded mailbox fails RunnerAtCapacity after deliveryTimeout, never MailboxFull",
    timeoutMs: 30_000,
    run: ({ environment, expect }) =>
      withCapacity(
        environment,
        { maxResidentActors: 8 },
        Effect.gen(function* () {
          const test = yield* ActorTest
          const ids = Array.from({ length: 32 }, (_, index) => `actor-${index}`)

          const outcomes = yield* Effect.forEach(
            [...ids, ...ids],
            (id) =>
              Effect.gen(function* () {
                const actor = yield* Unbounded.get(id)
                const started = yield* Clock.currentTimeMillis
                const exit = yield* actor.Touch().pipe(Effect.exit)

                return { id, exit, elapsedMs: (yield* Clock.currentTimeMillis) - started }
              }),
            { concurrency: "unbounded" },
          )

          const reasons = outcomes.map(({ exit }) => reasonOf(exit))
          expect(reasons.filter((reason) => reason === "MailboxFull")).toEqual([])
          expect(
            reasons.filter((reason) => reason !== "success" && reason !== "RunnerAtCapacity"),
          ).toEqual([])

          const admitted = new Set(
            outcomes.filter(({ exit }) => Exit.isSuccess(exit)).map(({ id }) => id),
          )

          expect(admitted.size).toBe(8)

          const rejected = outcomes.filter(({ exit }) => Exit.isFailure(exit))
          expect(rejected.length).toBe(48)

          for (const { id, exit, elapsedMs } of rejected) {
            expect(admitted.has(id)).toBe(false)
            expect(elapsedMs >= 4500).toBe(true)
            expect(Exit.findErrorOption(exit)).toMatchObject({
              value: { reason: RunnerAtCapacity.make({}), isRetryable: true },
            })
          }

          for (const id of ids) {
            const inspection = yield* test.inspect((yield* Unbounded.get(id)).ref)
            expect(inspection.receipts).toBe(admitted.has(id) ? 2 : 0)
          }
        }),
      ),
  },
  {
    name: "a bounded mailbox that is not resident reports RunnerAtCapacity, not MailboxFull",
    timeoutMs: 30_000,
    run: ({ environment, expect }) =>
      withCapacity(
        environment,
        { maxResidentActors: 1 },
        Effect.gen(function* () {
          expect(yield* (yield* Bounded.get("resident")).Touch()).toBe(1)
          const exit = yield* (yield* Bounded.get("waiting")).Touch().pipe(Effect.exit)
          expect(reasonOf(exit)).toBe("RunnerAtCapacity")
        }),
      ),
  },
  {
    name: "a resident bounded actor with a full mailbox still reports MailboxFull",
    requiresIndependentConnections: true,
    timeoutMs: 30_000,
    run: ({ environment, expect }) =>
      withCapacity(
        environment,
        { maxResidentActors: 10 },
        Effect.gen(function* () {
          const actor = yield* Bounded.get("busy")
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          hold = Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))

          const held = yield* actor.Hold().pipe(Effect.forkScoped)
          yield* Deferred.await(reached)
          const exit = yield* actor.Touch().pipe(Effect.exit)
          expect(Exit.findErrorOption(exit)).toMatchObject({
            value: { reason: MailboxFull.make({}) },
          })
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.await(held)
          hold = Effect.void
        }),
      ),
  },
  {
    name: "a runner holding admission.concurrency commands refuses one that waits out admission.wait with ActorUnavailable, and that id runs exactly once after a slot frees",
    timeoutMs: 30_000,
    run: ({ environment, expect }) =>
      withCapacity(
        environment,
        { maxResidentActors: 8, admission: { concurrency: 2, wait: "50 millis" } },
        Effect.gen(function* () {
          const test = yield* ActorTest
          const first = yield* test.pauseNext("beforeDelivery")
          const second = yield* test.pauseNext("beforeDelivery")
          const heldA = yield* (yield* Unbounded.get("held-a")).Touch().pipe(Effect.forkScoped)
          const heldB = yield* (yield* Unbounded.get("held-b")).Touch().pipe(Effect.forkScoped)
          yield* first.reached
          yield* second.reached

          const refused = yield* Unbounded.get("refused")
          const touch = refused.Touch()
          const exit = yield* touch.pipe(Effect.exit)
          expect(reasonOf(exit)).toBe("ActorUnavailable")

          const refusal = Exit.findErrorOption(exit).pipe(
            Option.filter(Schema.is(ActorError)),
            Option.getOrThrow,
          )

          expect(refusal.isRetryable).toBe(true)
          expect(Option.isSome(refusal.retryAfter)).toBe(true)
          expect(yield* test.inspect(refused.ref)).toMatchObject({
            generation: undefined,
            receipts: 0,
          })

          yield* first.release
          yield* second.release
          expect(yield* Fiber.join(heldA)).toBe(1)
          expect(yield* Fiber.join(heldB)).toBe(1)

          expect(yield* touch).toBe(1)
          expect(yield* touch).toBe(1)
          expect(yield* test.inspect(refused.ref)).toMatchObject({
            receipts: 1,
            state: { count: 1 },
          })
        }),
      ),
  },
  {
    name: "interrupting a command waiter does not free its runtime admission slot or cancel its accepted command",
    timeoutMs: 30_000,
    run: ({ environment, expect }) =>
      withCapacity(
        environment,
        { maxResidentActors: 8, admission: { concurrency: 1, wait: "50 millis" } },
        Effect.gen(function* () {
          const test = yield* ActorTest
          const actor = yield* Unbounded.get("interrupted")
          const pause = yield* test.pauseNext("beforeDelivery")
          const touch = actor.Touch()
          const caller = yield* touch.pipe(Effect.forkScoped)
          yield* pause.reached
          yield* Fiber.interrupt(caller)
          const other = yield* Unbounded.get("still-full")
          expect(reasonOf(yield* other.Touch().pipe(Effect.exit))).toBe("ActorUnavailable")
          expect(yield* test.inspect(other.ref)).toMatchObject({ receipts: 0 })
          yield* pause.release
          yield* Effect.sleep("10 millis").pipe(
            Effect.repeat({
              until: Effect.fnUntraced(function* () {
                return (yield* test.inspect(actor.ref)).receipts === 1
              }),
            }),
          )
          expect(yield* touch).toBe(1)
          expect(yield* test.inspect(actor.ref)).toMatchObject({ receipts: 1, state: { count: 1 } })
          expect(yield* other.Touch()).toBe(1)
        }),
      ),
  },
  {
    name: "a command cut off by runtime shutdown, or sent through a retained handle while or after the runtime closes, fails retryable ActorUnavailable within the bound and shutdown returns",
    timeoutMs: 30_000,
    run: ({ environment, expect }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase
          const runtime = yield* Scope.make()

          const services = yield* Layer.buildWithScope(
            Layer.fresh(
              CapacityLive.pipe(
                Layer.provideMerge(ActorTest.layer({ database, maxResidentActors: 8 })),
                Layer.provide(Layer.succeed(Crypto.Crypto, yield* Crypto.Crypto)),
                Layer.orDie,
              ),
            ),
            runtime,
          )

          const actor = yield* WarmUp.get("warm-up").pipe(
            Effect.flatMap((warmUp) => warmUp.Touch()),
            Effect.andThen(Unbounded.get("shutdown")),
            Effect.provideContext(services),
          )

          const retained = actor.Touch()
          expect(yield* retained).toBe(1)
          const pause = yield* Context.get(services, ActorTest).pauseNext("beforeDelivery")
          const settle = (call: typeof retained) =>
            call.pipe(Effect.exit, Effect.timeoutOption(SHUTDOWN_BOUND))
          const inFlight = yield* settle(actor.Touch()).pipe(Effect.forkChild)
          yield* pause.reached

          const closing = yield* Scope.close(runtime, Exit.void).pipe(
            Effect.timeoutOption(SHUTDOWN_BOUND),
            Effect.forkChild,
          )
          yield* Effect.yieldNow.pipe(
            Effect.repeat({ until: () => Predicate.isTagged(runtime.state, "Closed") }),
          )
          const during = yield* settle(actor.Touch())
          const closed = yield* Fiber.join(closing)
          const after = yield* settle(retained)

          expect(Option.isSome(closed)).toBe(true)

          const outcomes = [yield* Fiber.join(inFlight), during, after]
          expect(outcomes.map(Option.map(reasonOf))).toEqual(
            Array.from({ length: 3 }, () => Option.some("ActorUnavailable")),
          )

          for (const exit of outcomes.map(Option.getOrThrow)) {
            expect(Exit.hasInterrupts(exit)).toBe(false)
            expect(Exit.findErrorOption(exit)).toMatchObject({ value: { isRetryable: true } })
          }
        }),
      ),
  },
  {
    name: "a delivery timeout retains admission until the accepted turn settles, then the same id replays exactly once",
    requiresIndependentConnections: true,
    timeoutMs: 30_000,
    run: ({ environment, expect }) =>
      withCapacity(
        environment,
        { maxResidentActors: 8, admission: { concurrency: 1, wait: "50 millis" } },
        Effect.gen(function* () {
          const test = yield* ActorTest
          const actor = yield* Unbounded.get("timed-out")
          const pause = yield* test.pauseNext("beforeHandler")
          const touch = actor.Touch()
          const caller = yield* touch.pipe(Effect.forkScoped)
          yield* pause.reached
          expect(reasonOf(yield* Fiber.await(caller))).toBe("Timeout")

          const other = yield* Unbounded.get("timeout-still-full")
          expect(reasonOf(yield* other.Touch().pipe(Effect.exit))).toBe("ActorUnavailable")
          expect(yield* test.inspect(other.ref)).toMatchObject({ receipts: 0 })

          yield* pause.release
          yield* Effect.sleep("10 millis").pipe(
            Effect.repeat({
              until: Effect.fnUntraced(function* () {
                return (yield* test.inspect(actor.ref)).receipts === 1
              }),
            }),
          )
          expect(yield* touch).toBe(1)
          expect(yield* test.inspect(actor.ref)).toMatchObject({ receipts: 1, state: { count: 1 } })
          expect(yield* other.Touch()).toBe(1)
        }),
      ),
  },
  {
    name: "a full turn checkout queue refuses before the handler or fence and retries the same id exactly once after capacity returns",
    requiresIndependentConnections: true,
    timeoutMs: 30_000,
    run: ({ environment, expect }) =>
      withCapacity(
        environment,
        { maxResidentActors: 8 },
        Effect.gen(function* () {
          const turns = Option.getOrThrow(yield* Effect.serviceOption(TurnConnections))
          const test = yield* ActorTest
          const held = yield* Scope.fork(yield* Effect.scope)
          yield* Effect.forEach(Array.from({ length: 10 }), () =>
            turns.lease.pipe(Scope.provide(held)),
          )
          const release = yield* Deferred.make<void>()
          const queued = yield* Effect.forEach(Array.from({ length: 64 }), () =>
            Effect.scoped(Effect.andThen(turns.lease, Deferred.await(release))).pipe(
              Effect.forkScoped,
            ),
          )
          yield* Effect.yieldNow.pipe(
            Effect.repeat({ until: () => turns.sessions().waiting === 64 }),
          )
          const actor = yield* Unbounded.get("pool-refused")
          const touch = actor.Touch()
          const exit = yield* touch.pipe(Effect.exit)
          expect(reasonOf(exit)).toBe("ActorUnavailable")
          expect(yield* test.inspect(actor.ref)).toMatchObject({
            generation: undefined,
            receipts: 0,
          })
          for (const fiber of queued) yield* Fiber.interrupt(fiber)
          yield* Scope.close(held, Exit.void)
          expect(yield* touch).toBe(1)
          expect(yield* touch).toBe(1)
          expect(yield* test.inspect(actor.ref)).toMatchObject({ receipts: 1, state: { count: 1 } })
        }),
      ),
  },
  {
    name: "an activation holding its default mailbox bound refuses the next command at once with ActorUnavailable, never MailboxFull, and that command never runs",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ environment, expect }) => {
      let waiting = 0

      return withCapacity(
        environment,
        {
          maxResidentActors: 8,
          admission: { concurrency: ACTIVATION_MAILBOX * 2 },
          at: (point, request) =>
            Effect.sync(() => {
              if (point === "queued" && request.ref.id === "hot") waiting += 1
            }),
        },
        Effect.gen(function* () {
          const test = yield* ActorTest
          const actor = yield* Hot.get("hot")
          const paused = yield* test.pauseNext("beforeHandler")
          const held = yield* actor.Touch().pipe(Effect.forkScoped)
          yield* paused.reached

          const queued = yield* Effect.forEach(
            Array.from({ length: ACTIVATION_MAILBOX - 1 }),
            (_, index) =>
              Effect.gen(function* () {
                const fiber = yield* actor.Touch().pipe(Effect.forkScoped)
                yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => waiting === index + 2 }))

                return fiber
              }),
          )

          const overflow = actor.Touch()
          const exit = yield* overflow.pipe(Effect.exit)
          expect(reasonOf(exit)).toBe("ActorUnavailable")
          expect(waiting).toBe(ACTIVATION_MAILBOX)

          yield* paused.release
          yield* Fiber.join(held)
          const values = yield* Effect.forEach(queued, Fiber.join)
          expect(values.length).toBe(ACTIVATION_MAILBOX - 1)
          expect(yield* test.inspect(actor.ref)).toMatchObject({
            receipts: ACTIVATION_MAILBOX,
            state: { count: ACTIVATION_MAILBOX },
          })

          expect(yield* overflow).toBe(ACTIVATION_MAILBOX + 1)
          expect(yield* test.inspect(actor.ref)).toMatchObject({
            receipts: ACTIVATION_MAILBOX + 1,
            state: { count: ACTIVATION_MAILBOX + 1 },
          })
        }),
      )
    },
  },
  {
    name: "a remote default mailbox refuses with serialized ActorUnavailable and retryAfter without retrying or receipting the command",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ environment, expect }) =>
      environment.run(
        Effect.gen(function* () {
          const services = yield* Layer.build(
            clusterLayer({
              database: yield* environment.freshDatabase,
              runners: 2,
              holdersOnly: [1],
              shardLockExpiration: "5 seconds",
              admission: { concurrency: ACTIVATION_MAILBOX * 2 },
              actors: CapacityLive,
            }).pipe(Layer.provide(Layer.succeed(Crypto.Crypto, yield* Crypto.Crypto))),
          )
          const cluster = Context.get(services, ActorCluster)
          yield* cluster.ready
          const actor = yield* cluster.on(1)(Hot.get("remote-hot"))
          expect(yield* cluster.on(1)(actor.Touch())).toBe(1)
          const pause = yield* cluster.on(0)(
            Effect.flatMap(ActorTest, (test) => test.pauseNext("beforeHandler")),
          )
          const held = yield* cluster.on(1)(actor.Touch()).pipe(Effect.forkScoped)
          yield* pause.reached

          const queued = yield* Effect.forEach(Array.from({ length: ACTIVATION_MAILBOX - 1 }), () =>
            Effect.gen(function* () {
              const reached = yield* cluster.on(0)(
                Effect.flatMap(ActorTest, (test) => test.pauseNext("queued")),
              )
              const fiber = yield* cluster.on(1)(actor.Touch()).pipe(Effect.forkScoped)
              yield* reached.reached
              yield* reached.release
              return fiber
            }),
          )
          const overflow = actor.Touch()
          const exit = yield* cluster.on(1)(overflow).pipe(Effect.exit)
          expect(reasonOf(exit)).toBe("ActorUnavailable")
          const error = Exit.findErrorOption(exit).pipe(
            Option.filter(Schema.is(ActorError)),
            Option.getOrThrow,
          )
          expect(error.reason).toMatchObject({ overloaded: true })
          expect(error.isRetryable).toBe(true)
          const retryAfter = Option.getOrThrow(error.retryAfter)
          expect(retryAfter >= 125 && retryAfter <= 375).toBe(true)

          yield* pause.release
          yield* Fiber.join(held)
          yield* Effect.forEach(queued, Fiber.join)
          const inspect = cluster.on(0)(
            Effect.flatMap(ActorTest, (test) => test.inspect(actor.ref)),
          )
          expect(yield* inspect).toMatchObject({
            receipts: ACTIVATION_MAILBOX + 1,
            state: { count: ACTIVATION_MAILBOX + 1 },
          })
          expect(yield* cluster.on(1)(overflow)).toBe(ACTIVATION_MAILBOX + 2)
          expect(yield* cluster.on(1)(overflow)).toBe(ACTIVATION_MAILBOX + 2)
          expect(yield* inspect).toMatchObject({
            receipts: ACTIVATION_MAILBOX + 2,
            state: { count: ACTIVATION_MAILBOX + 2 },
          })
        }),
      ),
  },
  {
    name: "a caller over capacity succeeds on retry once an idle actor hibernates",
    timeoutMs: 40_000,
    run: ({ environment, expect }) =>
      withCapacity(
        environment,
        { maxResidentActors: 2 },
        Effect.gen(function* () {
          const test = yield* ActorTest
          expect(yield* (yield* Sleepy.get("first")).Touch()).toBe(1)
          expect(yield* (yield* Sleepy.get("second")).Touch()).toBe(1)

          const third = yield* Sleepy.get("third")
          expect(yield* third.Touch()).toBe(1)
          expect(yield* test.inspect(third.ref)).toMatchObject({ receipts: 1, state: { count: 1 } })
        }),
      ),
  },
  {
    name: "hibernates an idle actor within one idle sweep of its hibernateAfter when a type with a longer one registered first",
    timeoutMs: 45_000,
    run: ({ environment, expect }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase

          const services = yield* Layer.build(
            Layer.fresh(
              HibernationLive.pipe(
                Layer.provideMerge(ActorTest.layer({ database, maxResidentActors: 2 })),
                Layer.provide(Layer.succeed(Crypto.Crypto, yield* Crypto.Crypto)),
                Layer.orDie,
              ),
            ),
          )

          yield* Effect.gen(function* () {
            yield* (yield* Patient.get("stays")).Touch()
            yield* (yield* Quick.get("idle")).Touch()
            const waiting = yield* Quick.get("waiting")
            const started = yield* Clock.currentTimeMillis
            const exit = yield* waiting.Touch().pipe(Effect.exit)

            expect(reasonOf(exit)).toBe("success")
            expect((yield* Clock.currentTimeMillis) - started < 1_000 + SWEEP_MS + 3_000).toBe(true)
          }).pipe(Effect.provideContext(services))
        }),
      ),
  },
]
