import { BunCrypto } from "@effect/platform-bun"
import { ActorTest } from "@durable-actors/core/testing"
import { Effect, Layer, Queue, Stream } from "effect"
import type { Instruments } from "../backend.ts"
import { load } from "../measure.ts"
import { Plain, ProgressProbe, ProgressProbeLive, QuietProbe, Watch } from "../probe/progress.ts"
import {
  type CaseResult,
  DEFAULT_POOL,
  measure,
  type Scenario,
  type ScenarioContext,
} from "../scenario.ts"

type Services = Layer.Success<ReturnType<typeof testLayer>>

const testLayer = (database: Parameters<typeof ActorTest.layer>[0]["database"]) =>
  Layer.fresh(
    ProgressProbeLive.pipe(
      Layer.provideMerge(ActorTest.layer({ database })),
      Layer.provide(BunCrypto.layer),
      Layer.orDie,
    ),
  )

const withProgress = <A, E>(
  context: ScenarioContext,
  body: (instruments: Instruments | undefined) => Effect.Effect<A, E, Services>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* context.backend.database({ maxConnections: DEFAULT_POOL })
      const services = yield* Layer.build(testLayer(database.url))

      return yield* body(database.instruments).pipe(Effect.provideContext(services), Effect.orDie)
    }),
  )

const percentile = (samples: ReadonlyArray<number>, rank: number) => {
  const sorted = samples.toSorted((a, b) => a - b)

  return (
    Math.round(
      (sorted[Math.min(sorted.length - 1, Math.floor(rank * sorted.length))] ?? 0) * 1000,
    ) / 1000
  )
}

/**
 * Executor progress on one runner: from a command that performs `Report`
 * until its executor's one frame reaches a connection, and until its route's
 * broadcast does, for an actor type that receives the progress and one that
 * does not, whose pool sends no progress messages at all.
 */
export const progress: Scenario = {
  name: "progress",
  description:
    "Executor progress through the owner to a held connection: command to frame, and command to route broadcast with and without an opted-in member.",
  run: (context) =>
    Effect.gen(function* () {
      const operations = context.profile === "quick" ? 100 : 500
      const results: Array<CaseResult> = []

      const cases = [
        { name: "frame-to-client", probe: ProgressProbe, member: Watch, wait: "Progress" },
        { name: "route-opted-in", probe: ProgressProbe, member: Watch, wait: "Frame" },
        { name: "route-not-opted-in", probe: QuietProbe, member: Plain, wait: "Frame" },
      ] as const

      for (const entry of cases)
        results.push(
          yield* withProgress(context, (instruments) =>
            Effect.scoped(
              Effect.gen(function* () {
                const test = yield* ActorTest
                const handle = yield* entry.probe.get(entry.name)
                const connection = yield* test.connect(handle.ref, entry.member, undefined)
                let index = 0

                // The client reads all the time, as a socket would: progress it has not
                // read when the route commits is discarded by design.
                const arrived = yield* Queue.unbounded<{
                  readonly tag: string
                  readonly at: number
                }>()

                yield* connection.messages.pipe(
                  Stream.runForEach((message) =>
                    Queue.offer(arrived, { tag: message._tag, at: performance.now() }),
                  ),
                  Effect.forkScoped,
                )

                // Milliseconds from each command's call until the awaited envelope reached the client.
                const latencies: Array<number> = []

                const next = (started: number) =>
                  Effect.gen(function* () {
                    for (;;) {
                      const message = yield* Queue.take(arrived)

                      if (message.tag === entry.wait) return latencies.push(message.at - started)
                    }
                  })

                // `ActorTest` runs due effects and routes when `advance` asks it to; the
                // operation spans the whole round trip, and `extra` holds the arrival times.
                const operation = () =>
                  Effect.suspend(() => {
                    const started = performance.now()

                    return handle
                      .Start(`${entry.name}-${index++}`)
                      .pipe(Effect.andThen(test.advance(0)), Effect.andThen(next(started)))
                  })

                yield* load({ workers: 1, operations: 20, operation })
                const before = (yield* test.progress).length
                latencies.length = 0

                const result = yield* measure({
                  name: entry.name,
                  parameters: { connections: 1, workers: 1 },
                  instruments,
                  workers: 1,
                  operations,
                  operation,
                  listStatements: true,
                })

                const sent = (yield* test.progress).length - before

                return {
                  ...result,
                  extra: {
                    ...result.extra,
                    progressMessagesPerOperation: sent / operations,
                    arrivalP50Ms: percentile(latencies, 0.5),
                    arrivalP99Ms: percentile(latencies, 0.99),
                  },
                }
              }),
            ),
          ),
        )

      return results
    }),
}
