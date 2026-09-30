import {
  Clock,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  type Scope,
} from "effect"
import { Actor, ActorError, Actors, MailboxFull, RunnerAtCapacity } from "../../index.ts"
import { ActorTest } from "../actor-test.ts"
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
  WarmUp.toLayer(Effect.succeed({ Touch: () => Effect.succeed(0) })),
)

/**
 * A runtime of its own on a fresh database, so only these actors hold resident
 * slots. A runner on Postgres takes seconds to acquire its shards, so one
 * warm-up command with a long delivery timeout runs first, in a slot of its own.
 */
const withCapacity = <A, E>(
  environment: ConformanceEnvironment,
  maxResidentActors: number,
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
              ActorTest.layer({ database, maxResidentActors: maxResidentActors + 1 }),
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

/** Capacity cases: a caller over capacity gets `RunnerAtCapacity` after `deliveryTimeout`, while a resident bounded actor with a full mailbox reports `MailboxFull`. */
export const capacityConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "over-capacity load on an unbounded mailbox fails RunnerAtCapacity after deliveryTimeout, never MailboxFull",
    timeoutMs: 30_000,
    run: ({ environment, expect }) =>
      withCapacity(
        environment,
        8,
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
        1,
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
        10,
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
    name: "a caller over capacity succeeds on retry once an idle actor hibernates",
    timeoutMs: 40_000,
    run: ({ environment, expect }) =>
      withCapacity(
        environment,
        2,
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
