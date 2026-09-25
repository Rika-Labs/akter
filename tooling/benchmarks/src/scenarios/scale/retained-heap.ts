import { heapStats } from "bun:jsc"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { load } from "../../measure.ts"
import { SleepyProbe } from "../../probe/contract.ts"
import { type CaseResult, DEFAULT_POOL, measure, type Scenario } from "../../scenario.ts"

const WORKERS = 64

/**
 * Two of Cluster's 5-second reaper sweeps, so every idle activation is gone
 * even when a sweep is still removing a large batch.
 */
const HIBERNATION_WAIT = "13 seconds"

/**
 * Live JavaScript heap after a full collection. ArrayBuffer memory is left
 * out: PGlite keeps its database pages there, and they grow with stored rows,
 * not with anything the runtime retains.
 */
const retained = Effect.sync(() => {
  Bun.gc(true)
  const stats = heapStats()

  return { bytes: stats.heapSize - stats.extraMemorySize, objects: stats.objectCount }
})

const perUnit = (
  before: { bytes: number; objects: number },
  after: typeof before,
  units: number,
) => ({
  kib: Math.round(((after.bytes - before.bytes) / 1024 / units) * 1000) / 1000,
  objects: Math.round(((after.objects - before.objects) / units) * 100) / 100,
})

const touch = (id: string) => SleepyProbe.get(id).pipe(Effect.flatMap((probe) => probe.Add(1)))

/** SleepyProbe activations that hibernated: their generation advanced past the first. */
const hibernated = (id: string) =>
  Effect.gen(function* () {
    yield* touch(id).pipe(Effect.orDie)
    const sql = yield* SqlClient.SqlClient

    const [row] = yield* sql<{ generation: string }>`
      SELECT generation::text AS generation FROM actor_generations
      WHERE actor_type = 'SleepyProbe' AND actor_id = ${id}`.pipe(Effect.orDie)

    return Number(row!.generation) >= 2 ? 1 : 0
  })

/**
 * Heap a runner keeps for work it has finished. `touch-<n>` first-touches n
 * SleepyProbe actors, waits until every activation hibernated, and reports
 * the JavaScript heap still retained per touched actor. `one-actor-<n>` sends
 * n commands to one actor and reports the heap retained per command after it
 * hibernated.
 */
export const retainedHeap: Scenario = {
  name: "retained-heap",
  description: `Heap retained after work finishes: ${WORKERS} callers first-touch n actors that all hibernate (touch-<n>, per actor), and n sequential commands to one actor that hibernates (one-actor-<n>, per command). Excludes ArrayBuffers, where PGlite keeps its pages.`,
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const postgres = context.backend.name === "postgres"
      const results: Array<CaseResult> = []
      const counts = quick ? [1000] : postgres ? [10_000, 100_000] : [10_000]

      for (const actors of counts)
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              yield* load({
                workers: WORKERS,
                operations: 1000,
                operation: (i) => touch(`warm-${i}`),
              })
              yield* Effect.sleep(HIBERNATION_WAIT)
              const before = yield* retained

              const first = yield* measure({
                name: `touch-${actors}`,
                parameters: { actors, workers: WORKERS, pool: DEFAULT_POOL, hibernateAfterMs: 250 },
                instruments,
                workers: WORKERS,
                operations: actors,
                operation: (index) => touch(`actor-${index}`),
              })

              const touched = yield* retained
              yield* Effect.sleep(HIBERNATION_WAIT)
              const after = yield* retained
              const resident = perUnit(before, touched, actors)
              const kept = perUnit(before, after, actors)

              return {
                ...first,
                extra: {
                  kibPerActorAfterTouch: resident.kib,
                  kibPerActorAfterHibernation: kept.kib,
                  objectsPerActorAfterHibernation: kept.objects,
                  sampleHibernated: yield* hibernated("actor-0"),
                },
              }
            }),
          ),
        )

      const commands = quick ? 1000 : 10_000

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            yield* load({ workers: 1, operations: 1000, operation: () => touch("warm") })
            yield* Effect.sleep(HIBERNATION_WAIT)
            const before = yield* retained

            const repeated = yield* measure({
              name: `one-actor-${commands}`,
              parameters: { commands, workers: 1, pool: DEFAULT_POOL, hibernateAfterMs: 250 },
              instruments,
              workers: 1,
              operations: commands,
              operation: () => touch("single"),
            })

            yield* Effect.sleep(HIBERNATION_WAIT)
            const kept = perUnit(before, yield* retained, commands)

            return {
              ...repeated,
              extra: {
                kibPerCommandAfterHibernation: kept.kib,
                objectsPerCommandAfterHibernation: kept.objects,
                sampleHibernated: yield* hibernated("single"),
              },
            }
          }),
        ),
      )

      return results
    }),
}
