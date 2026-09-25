import { heapStats } from "bun:jsc"
import { Crypto, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { Actor, User } from "../../index.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase } from "../conformance.ts"

const Touch = Actor.command("Touch", { output: Schema.Finite })

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

/**
 * Live JavaScript heap after a full collection. ArrayBuffer memory is left
 * out: an in-process database keeps its pages there, and they grow with
 * stored rows rather than with anything the runtime retains.
 */
const retained = Effect.sync(() => {
  Bun.gc(true)
  const stats = heapStats()

  return { bytes: stats.heapSize - stats.extraMemorySize, objects: stats.objectCount }
})

export const heapConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "retains bounded heap for touched actors once every activation hibernates",
    timeoutMs: 120_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase

          const runtime = yield* Effect.acquireRelease(
            Effect.map(Crypto.Crypto, (crypto) =>
              ManagedRuntime.make(
                SleeperLive.pipe(
                  Layer.provideMerge(
                    ActorTest.layer({ database, as: User.make({ subject: "alice" }) }),
                  ),
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

          // Cluster's reaper sweeps at most every 5 seconds, so two sweeps
          // pass before any activation is still resident.
          const hibernate = Effect.sleep("11 seconds")

          const { before, after, generation } = yield* Effect.promise(() =>
            runtime.runPromise(
              Effect.gen(function* () {
                yield* touchAll("warm")
                yield* hibernate
                const before = yield* retained
                yield* touchAll("actor")
                yield* hibernate
                const after = yield* retained
                const sample = yield* Sleeper.get("actor-0")
                yield* sample.Touch()
                const test = yield* ActorTest

                return { before, after, generation: (yield* test.inspect(sample.ref)).generation }
              }),
            ),
          )

          expect(generation).toBe("2")
          expect((after.objects - before.objects) / ACTORS).toBeLessThan(10)
          expect((after.bytes - before.bytes) / ACTORS).toBeLessThan(1024)
        }),
      ),
  },
]
