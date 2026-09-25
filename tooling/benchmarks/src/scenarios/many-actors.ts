import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { load, shuffled } from "../measure.ts"
import { Probe } from "../probe/contract.ts"
import { type CaseResult, DEFAULT_POOL, measure, type Scenario } from "../scenario.ts"

const WORKERS = 64

const add = (actor: number) =>
  Probe.get(`actor-${actor}`).pipe(Effect.flatMap((probe) => probe.Add(1)))

/** A uniform pick that is deterministic per operation index. */
export const pick = (actors: number) => (index: number) =>
  Number((BigInt(index) * 2_654_435_761n) % BigInt(actors))

/** Resident and heap memory after a full collection, in MiB. */
const memory = Effect.sync(() => {
  Bun.gc(true)
  const { rss, heapUsed } = process.memoryUsage()

  return { rss: rss / 1024 / 1024, heap: heapUsed / 1024 / 1024 }
})

const round = (value: number) => Math.round(value * 10) / 10

/** Total activations of Probe actors so far: each new activation advances a generation. */
const activations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql<{ total: string }>`
    SELECT coalesce(sum(generation), 0)::text AS total
    FROM actor_generations WHERE actor_type = 'Probe'`.pipe(Effect.orDie)

  return Number(row!.total)
})

/** The runtime's default `maxResidentActors`. */
const MAX_RESIDENT_ACTORS = 10_000

/**
 * The resident limit for a count: the default, or the count itself past it,
 * because with the default a caller over the limit retries for the whole
 * 30-second delivery timeout and 90,000 of them would take hours.
 */
const residentLimit = (actors: number) => Math.max(actors, MAX_RESIDENT_ACTORS)

const HIBERNATE_AFTER_MS = 60_000

/**
 * Concurrent callers spread over many actors. First touch creates and
 * activates every actor once; steady state then picks actors uniformly. An
 * actor stays warm only while it is resident: the runner keeps
 * `maxResidentActors` activations (10,000 by default, raised to 100,000 for
 * the 100k count), and an idle one hibernates after 60 seconds, so
 * `extra.coldFraction` reports how many steady-state turns started a new
 * activation. A pool sweep isolates the connection pool.
 */
export const manyActors: Scenario = {
  name: "many-actors",
  description: `${WORKERS} concurrent callers over 1k/10k/100k actors: first touch (create + activate each actor once), then uniform steady-state load (warm only while resident; see coldFraction), then a connection-pool sweep at 10k actors.`,
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const postgres = context.backend.name === "postgres"
      const results: Array<CaseResult> = []
      const durationMs = quick ? 3000 : 20_000

      const counts = quick ? [1000] : postgres ? [1000, 10_000, 100_000] : [1000, 10_000]

      for (const actors of counts)
        results.push(
          ...(yield* context.withRuntime(
            { maxResidentActors: residentLimit(actors) },
            (instruments) =>
              Effect.gen(function* () {
                const order = shuffled(actors)
                const before = yield* memory

                const first = yield* measure({
                  name: `first-touch-${actors}`,
                  parameters: {
                    actors,
                    workers: WORKERS,
                    pool: DEFAULT_POOL,
                    maxResidentActors: residentLimit(actors),
                  },
                  instruments,
                  workers: WORKERS,
                  operations: actors,
                  operation: (index) => add(order[index]!),
                })

                const after = yield* memory
                const activated = yield* activations

                const steady = yield* measure({
                  name: `steady-${actors}`,
                  parameters: {
                    actors,
                    workers: WORKERS,
                    pool: DEFAULT_POOL,
                    hibernateAfterMs: HIBERNATE_AFTER_MS,
                    maxResidentActors: residentLimit(actors),
                  },
                  instruments,
                  workers: WORKERS,
                  durationMs,
                  operation: (index) => add(pick(actors)(index)),
                })

                const cold = (yield* activations) - activated

                const cases: Array<CaseResult> = [
                  {
                    ...first,
                    extra: {
                      rssDeltaMiB: round(after.rss - before.rss),
                      heapDeltaMiB: round(after.heap - before.heap),
                      rssKiBPerActor: round(((after.rss - before.rss) * 1024) / actors),
                    },
                  },
                  {
                    ...steady,
                    extra: {
                      coldFraction:
                        steady.operations === 0
                          ? 0
                          : Math.round((cold / steady.operations) * 1000) / 1000,
                    },
                  },
                ]

                return cases
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
                operation: (index) => add(pick(actors)(index)),
              })
            }),
          ),
        )

      return results
    }),
}
