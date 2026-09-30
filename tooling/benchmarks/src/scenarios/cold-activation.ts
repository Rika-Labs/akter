import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { load } from "../measure.ts"
import { Probe, SleepyProbe } from "../probe/contract.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

/**
 * Idle time after which every SleepyProbe activation has hibernated: Cluster's
 * entity reaper sweeps at most every 5 seconds, whatever `hibernateAfter` says.
 */
export const HIBERNATION_WAIT = "6500 millis"

/**
 * Counts SleepyProbe actors whose generation advanced past the priming
 * activation, proving the measured turn really started a new activation.
 */
export const reactivated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql<{ fenced: number; total: number }>`
    SELECT count(*) FILTER (WHERE generation >= 2)::int AS fenced, count(*)::int AS total
    FROM actor_generations WHERE actor_type = 'SleepyProbe'`.pipe(Effect.orDie)

  return row!.total === 0 ? 0 : Math.round((row!.fenced / row!.total) * 1000) / 1000
})

/**
 * The first turn of an activation: a never-seen actor (row creation plus
 * generation fence), and an actor waking after hibernation (fence plus state
 * read and decode).
 */
export const coldActivation: Scenario = {
  name: "cold-activation",
  description:
    "First turn of a new activation, sequentially: a never-seen actor, and an existing actor after it hibernated (new generation, state read from storage).",
  run: (context) =>
    Effect.gen(function* () {
      const results: Array<CaseResult> = []

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            yield* load({
              workers: 1,
              operations: 50,
              operation: (index) =>
                Probe.get(`warmup-${index}`).pipe(Effect.flatMap((probe) => probe.Add(1))),
            })

            return yield* measure({
              name: "new-actor",
              parameters: { workers: 1 },
              instruments,
              workers: 1,
              operations: context.quick ? 100 : 1000,
              operation: (index) =>
                Probe.get(`new-${index}`).pipe(Effect.flatMap((probe) => probe.Add(1))),
              listStatements: true,
            })
          }),
        ),
      )

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const actors = context.quick ? 50 : 500

            const wake = (index: number) =>
              SleepyProbe.get(`sleepy-${index}`).pipe(Effect.flatMap((probe) => probe.Add(1)))

            yield* load({ workers: 16, operations: actors, operation: wake })
            yield* Effect.sleep(HIBERNATION_WAIT)

            const result = yield* measure({
              name: "after-hibernation",
              parameters: { workers: 1, actors, hibernateAfterMs: 250 },
              instruments,
              workers: 1,
              operations: actors,
              operation: wake,
              listStatements: true,
            })

            return {
              ...result,
              extra: { reactivatedFraction: yield* reactivated },
            } satisfies CaseResult
          }),
        ),
      )

      return results
    }),
}
