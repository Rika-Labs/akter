import { Crypto, Effect, Layer, ManagedRuntime, Schedule, Schema } from "effect"
import { Actor, Actors } from "../../index.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase } from "../conformance.ts"

const Touch = Actor.command("Touch", { success: Schema.Finite })

const Sleeper = Actor.make("HeapSleeper", {
  key: Schema.String,
  state: Actor.state({ count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Touch },
  policy: { hibernateAfter: "250 millis" },
})

const SleeperLive = Sleeper.toLayer(
  Effect.succeed({
    Touch: Effect.fnUntraced(function* () {
      const turn = yield* Sleeper.Turn
      yield* turn.state.set({ count: turn.state.count + 1 })

      return turn.state.count
    }),
  }),
)

const ACTORS = 1000

const COMMANDS = 4_096

const HOT_ACTORS = 32

/**
 * Live JavaScript heap after a full collection. ArrayBuffer memory is left
 * out: an in-process database keeps its pages there, and they grow with
 * stored rows rather than with anything the runtime retains. `bun:jsc` is
 * loaded only when the case runs, so importing the testing entry needs no Bun.
 */
const retained = Effect.gen(function* () {
  const { heapStats } = yield* Effect.promise(() => import("bun:jsc"))
  Bun.gc(true)
  const stats = heapStats()

  return { bytes: stats.heapSize - stats.extraMemorySize, objects: stats.objectCount }
})

type Retained = Effect.Success<typeof retained>

/**
 * Samples the heap once a second until two samples agree to within one object
 * per actor, or 60 seconds pass. Cluster's reaper sweeps every 5 seconds and
 * releases a whole sweep's activations at once, so a settled heap means the
 * sweeps have run.
 */
const settled = Effect.gen(function* () {
  let previous = yield* retained

  return yield* Effect.gen(function* () {
    const next = yield* retained
    const done = Math.abs(previous.objects - next.objects) < ACTORS
    previous = next

    return done ? next : yield* Effect.fail("unsettled" as const)
  }).pipe(
    Effect.delay("1 second"),
    Effect.retry({ schedule: Schedule.recurs(60) }),
    Effect.orElseSucceed(() => previous),
  )
})

const perActor = (before: Retained, after: Retained) => ({
  objects: (after.objects - before.objects) / ACTORS,
  bytes: (after.bytes - before.bytes) / ACTORS,
})

/** Heap cases: bounded retained heap once activations hibernate and once Cluster forgets processed request ids. */
export const heapConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "retains bounded heap for touched actors once every activation hibernates",
    requiresFreshDatabase: true,
    timeoutMs: 120_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase

          const runtime = yield* Effect.acquireRelease(
            Effect.map(Crypto.Crypto, (crypto) =>
              ManagedRuntime.make(
                SleeperLive.pipe(
                  Layer.provideMerge(ActorTest.layer({ database })),
                  Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
                  Layer.orDie,
                ),
              ),
            ),
            (runtime) => Effect.promise(() => runtime.dispose()),
          )

          const touch = (id: string) =>
            Sleeper.get(id).pipe(Effect.flatMap((sleeper) => sleeper.Touch()))

          const touchAll = (prefix: string) =>
            Effect.forEach(
              Array.from({ length: ACTORS }, (_, index) => `${prefix}-${index}`),
              touch,
              { concurrency: 32, discard: true },
            )

          const hibernate = Effect.andThen(Effect.sleep("6 seconds"), settled)

          const { growth, generations } = yield* Effect.promise(() =>
            runtime.runPromise(
              Effect.gen(function* () {
                yield* touchAll("warm")
                const before = yield* hibernate
                yield* touchAll("actor")
                const growth = perActor(before, yield* hibernate)
                const test = yield* ActorTest

                const generations = yield* Effect.forEach([0, 250, 500, 750, 999], (index) =>
                  Effect.gen(function* () {
                    const sample = yield* Sleeper.get(`actor-${index}`)
                    yield* sample.Touch()

                    return (yield* test.inspect(sample.ref)).generation
                  }),
                )

                return { growth, generations }
              }),
            ),
          )

          expect(generations).toEqual(["2", "2", "2", "2", "2"])
          expect({ ...growth, bounded: growth.objects < 10 && growth.bytes < 1024 }).toMatchObject({
            bounded: true,
          })
        }),
      ),
  },
  {
    name: "retains bounded heap per command once Cluster forgets processed request ids",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase

          const runtime = yield* Effect.acquireRelease(
            Effect.map(Crypto.Crypto, (crypto) =>
              ManagedRuntime.make(
                SleeperLive.pipe(
                  Layer.provideMerge(ActorTest.layer({ database })),
                  Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
                  Layer.orDie,
                ),
              ),
            ),
            (runtime) => Effect.promise(() => runtime.dispose()),
          )

          const touch = (id: string) =>
            Sleeper.get(id).pipe(Effect.flatMap((sleeper) => sleeper.Touch()))

          const touchMany = Effect.forEach(
            Array.from({ length: COMMANDS }, (_, index) => `hot-${index % HOT_ACTORS}`),
            touch,
            { concurrency: HOT_ACTORS, discard: true },
          )

          const forget = Effect.andThen(Effect.sleep("11 seconds"), retained)

          const { growth, first, replayed, count } = yield* Effect.promise(() =>
            runtime.runPromise(
              Effect.gen(function* () {
                const id = yield* (yield* Actors).mintCommandId

                const saved = Sleeper.get("hot-0").pipe(
                  Effect.flatMap((sleeper) => sleeper.Touch().pipe(Actor.commandId(id))),
                )

                const first = yield* saved
                yield* touchMany
                yield* forget
                yield* touchMany
                const before = yield* forget
                yield* touchMany
                const after = yield* forget
                const replayed = yield* saved
                const count = yield* touch("hot-0")

                return {
                  growth: {
                    objects: (after.objects - before.objects) / COMMANDS,
                    bytes: (after.bytes - before.bytes) / COMMANDS,
                  },
                  first,
                  replayed,
                  count,
                }
              }),
            ),
          )

          expect({ first, replayed }).toEqual({ first: 1, replayed: 1 })
          expect(count).toBe((3 * COMMANDS) / HOT_ACTORS + 2)
          expect({ ...growth, bounded: growth.objects < 0.5 && growth.bytes < 64 }).toMatchObject({
            bounded: true,
          })
        }),
      ),
  },
]
