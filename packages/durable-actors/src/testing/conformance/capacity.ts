import { Clock, Crypto, Effect, Exit, Layer, Option, Schema } from "effect"
import { Actor, ActorError, Actors, RunnerAtCapacity } from "../../index.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"

const Touch = Actor.command("Touch", { output: Schema.Finite })

const count = Actor.state({
  count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

const Unbounded = Actor.make("CapacityUnbounded", {
  key: Schema.NonEmptyString,
  state: count,
  api: { Touch },
  policy: { deliveryTimeout: "1 second" },
})

const Bounded = Actor.make("CapacityBounded", {
  key: Schema.NonEmptyString,
  state: count,
  api: { Touch },
  policy: { deliveryTimeout: "1 second", mailboxCapacity: 4 },
})

// Cluster's idle sweep runs every 5 seconds at its fastest, so a waiting
// caller sees a slot free within about that long.
const Sleepy = Actor.make("CapacitySleepy", {
  key: Schema.NonEmptyString,
  state: count,
  api: { Touch },
  policy: { deliveryTimeout: "20 seconds", hibernateAfter: "1 second" },
})

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
    }),
  ),
)

/** A runtime of its own on a fresh database, so only these actors hold resident slots. */
const withCapacity = <A, E>(
  environment: ConformanceEnvironment,
  maxResidentActors: number,
  body: Effect.Effect<A, E, Actors | ActorTest>,
) =>
  environment.run(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      const database = yield* environment.freshDatabase

      // Fresh, or Cluster's Sharding layer is shared with the suite's runtime
      // through the memo map and keeps its runner limit.
      const services = yield* Layer.build(
        Layer.fresh(
          CapacityLive.pipe(
            Layer.provideMerge(ActorTest.layer({ database, maxResidentActors })),
            Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
            Layer.orDie,
          ),
        ),
      )

      return yield* body.pipe(Effect.provideContext(services))
    }),
  )

const reasonOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "success"
  const error = Exit.findErrorOption(exit)

  return Option.isSome(error) && Schema.is(ActorError)(error.value)
    ? error.value.reason._tag
    : "other"
}

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

          // Two callers per actor, all at once: activations race for 8 slots.
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
            // Retried for the whole delivery timeout before giving up.
            expect(elapsedMs >= 900).toBe(true)
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
]
