import { BunCrypto } from "@effect/platform-bun"
import { ActorTest } from "@durable-actors/core/testing"
import { Effect, Layer, Queue, type Scope, Stream } from "effect"
import type { Instruments } from "../backend.ts"
import { load } from "../measure.ts"
import { WatchProbe, WatchProbeLive } from "../probe/watch.ts"
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
    WatchProbeLive.pipe(
      Layer.provideMerge(ActorTest.layer({ database })),
      Layer.provide(BunCrypto.layer),
      Layer.orDie,
    ),
  )

/** Watches run in-process through `ActorTest`, so each case builds a test runtime on the case database. */
const withWatches = <A, E>(
  context: ScenarioContext,
  body: (instruments: Instruments | undefined) => Effect.Effect<A, E, Services | Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* context.backend.database({ maxConnections: DEFAULT_POOL })
      const services = yield* Layer.build(testLayer(database.url))

      return yield* body(database.instruments).pipe(
        Effect.scoped,
        Effect.provideContext(services),
        Effect.orDie,
      )
    }),
  )

/**
 * Creates the counters `actors` names, then opens `count` watches over them
 * in turn and waits for each one's first result, so no result from the setup
 * is left to be mistaken for one of a measured commit.
 */
const watchers = (actors: ReadonlyArray<string>, count: number) =>
  Effect.gen(function* () {
    yield* Effect.forEach(
      actors,
      (id) => Effect.flatMap(WatchProbe.get(id), (probe) => probe.Bump()),
      { concurrency: 16, discard: true },
    )

    return yield* Effect.forEach(
      Array.from({ length: count }, (_, index) => actors[index % actors.length]!),
      (id) =>
        Effect.gen(function* () {
          const probe = yield* WatchProbe.get(id)
          const received = yield* Queue.unbounded<number>()

          yield* probe.Total.watch().pipe(
            Stream.runForEach((value) => Queue.offer(received, value)),
            Effect.forkScoped,
          )

          yield* Queue.take(received)

          return { id, received }
        }),
      { concurrency: 16 },
    )
  })

/**
 * A commit's reach through `watch`: one turn that a watch reads, until every
 * watcher holds the new result. Warm cases bump a resident counter; the cold
 * case hibernates the actor first, so the turn wakes it and its parked watch
 * receives the frame from the new activation. `minInterval` is 1 ms.
 */
export const watch: Scenario = {
  name: "watch",
  description:
    "Query watch fan-out: a commit reaching 1, 100, and 1,000 watches of one actor, and 100 actors with a watch each, warm; and a commit that wakes a hibernated actor with one watch. Latency runs from the command to every watcher holding the new result; statements per commit include every rerun.",
  run: (context) =>
    Effect.gen(function* () {
      const operations = context.quick ? 50 : 300
      const results: Array<CaseResult> = []

      for (const fanout of context.quick ? [1, 100] : [1, 100, 1000])
        results.push(
          yield* withWatches(context, (instruments) =>
            Effect.gen(function* () {
              const probe = yield* WatchProbe.get(`fanout-${fanout}`)
              const held = yield* watchers([`fanout-${fanout}`], fanout)

              const bump = () =>
                Effect.andThen(
                  probe.Bump(),
                  Effect.forEach(held, ({ received }) => Queue.take(received), {
                    concurrency: "unbounded",
                    discard: true,
                  }),
                )

              yield* load({ workers: 1, operations: 10, operation: bump })

              return yield* measure({
                name: `fanout-${fanout}`,
                parameters: { watches: fanout, actors: 1, workers: 1 },
                instruments,
                workers: 1,
                operations: fanout >= 1000 ? Math.round(operations / 5) : operations,
                operation: bump,
                listStatements: true,
              })
            }),
          ),
        )

      results.push(
        yield* withWatches(context, (instruments) =>
          Effect.gen(function* () {
            const actors = Array.from({ length: 100 }, (_, index) => `many-${index}`)
            const held = yield* watchers(actors, actors.length)
            let next = 0

            const bump = () =>
              Effect.gen(function* () {
                const target = held[next++ % held.length]!
                const probe = yield* WatchProbe.get(target.id)
                yield* probe.Bump()
                yield* Queue.take(target.received)
              })

            yield* load({ workers: 1, operations: 50, operation: bump })

            return yield* measure({
              name: "actors-100",
              parameters: { watches: 100, actors: 100, workers: 1 },
              instruments,
              workers: 1,
              operations,
              operation: bump,
              listStatements: true,
            })
          }),
        ),
      )

      results.push(
        yield* withWatches(context, (instruments) =>
          Effect.gen(function* () {
            const test = yield* ActorTest
            const probe = yield* WatchProbe.get("cold")
            const [held] = yield* watchers(["cold"], 1)

            const bump = () =>
              Effect.gen(function* () {
                yield* test.hibernate(probe.ref)
                yield* probe.Bump()
                yield* Queue.take(held!.received)
              })

            yield* load({ workers: 1, operations: 10, operation: bump })

            return yield* measure({
              name: "cold-1",
              parameters: { watches: 1, actors: 1, workers: 1 },
              instruments,
              workers: 1,
              operations: Math.round(operations / 2),
              operation: bump,
              listStatements: true,
            })
          }),
        ),
      )

      return results
    }),
}
