import { Effect } from "effect"
import { load, shuffled } from "../measure.ts"
import { Probe } from "../probe/contract.ts"
import { type CaseResult, DEFAULT_POOL, measure, type Scenario } from "../scenario.ts"

const WORKERS = 64

const add = (actor: number) =>
  Probe.get(`actor-${actor}`).pipe(Effect.flatMap((probe) => probe.Add(1)))

/** A uniform pick that is deterministic per operation index. */
const pick = (index: number, actors: number) =>
  Number((BigInt(index) * 2_654_435_761n) % BigInt(actors))

const rssMiB = () => Math.round(process.memoryUsage().rss / 1024 / 1024)

/**
 * Concurrent callers spread over many actors. First touch creates and
 * activates every actor once; steady state then picks actors uniformly while
 * every activation is warm. A pool sweep isolates the connection pool.
 */
export const manyActors: Scenario = {
  name: "many-actors",
  description: `${WORKERS} concurrent callers over 1k/10k/100k actors: first touch (create + activate each actor once), then uniform steady-state load over warm activations, then a connection-pool sweep at 10k actors.`,
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const postgres = context.backend.name === "postgres"
      const results: Array<CaseResult> = []
      const durationMs = quick ? 3000 : 20_000

      const counts = quick ? [1000] : postgres ? [1000, 10_000, 100_000] : [1000, 10_000]

      for (const actors of counts)
        results.push(
          ...(yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const order = shuffled(actors)

              const first = yield* measure({
                name: `first-touch-${actors}`,
                parameters: { actors, workers: WORKERS, pool: DEFAULT_POOL },
                instruments,
                workers: WORKERS,
                operations: actors,
                operation: (index) => add(order[index]!),
              })

              const steady = yield* measure({
                name: `steady-${actors}`,
                parameters: { actors, workers: WORKERS, pool: DEFAULT_POOL },
                instruments,
                workers: WORKERS,
                durationMs,
                operation: (index) => add(pick(index, actors)),
                extra: { rssMiBAfterFirstTouch: rssMiB() },
              })

              return [first, steady]
            }),
          )),
        )

      if (!postgres || quick) return results

      for (const pool of [25, 50])
        results.push(
          yield* context.withRuntime({ maxConnections: pool }, (instruments) =>
            Effect.gen(function* () {
              const actors = 10_000
              yield* load({ workers: WORKERS, operations: actors, operation: add })

              return yield* measure({
                name: `steady-${actors}-pool-${pool}`,
                parameters: { actors, workers: WORKERS, pool },
                instruments,
                workers: WORKERS,
                durationMs,
                operation: (index) => add(pick(index, actors)),
              })
            }),
          ),
        )

      return results
    }),
}
