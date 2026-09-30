import { Effect } from "effect"
import { shuffled } from "../../measure.ts"
import { SleepyProbe } from "../../probe/contract.ts"
import { type CaseResult, DEFAULT_POOL, measure, type Scenario } from "../../scenario.ts"
import { activations, pick } from "./many-actors.ts"

const WORKERS = 64

/** Actors per resident slot in the over-limit cases. */
const OVERSUBSCRIPTION = 4

const HIBERNATE_AFTER_MS = 250

const add = (actor: number) =>
  SleepyProbe.get(`actor-${actor}`).pipe(Effect.flatMap((probe) => probe.Add(1)))

/**
 * `many-actors` with the actor count held at, then past, the runner's
 * `maxResidentActors`. A caller whose actor can't get a slot receives the
 * retryable `RunnerAtCapacity` and its handle retries with the same command id
 * until Cluster's idle sweep evicts a hibernated activation, so the over-limit
 * cases time that wait. `SleepyProbe` hibernates after 250 ms, so slots free
 * at every sweep instead of after the default 60 seconds.
 */
export const capacity: Scenario = {
  name: "capacity",
  description: `${WORKERS} concurrent callers on SleepyProbe actors with a small maxResidentActors: first touch and uniform steady state with as many actors as slots, then with ${OVERSUBSCRIPTION}x as many, where callers over the limit retry RunnerAtCapacity until an idle activation is evicted.`,
  run: (context) =>
    Effect.gen(function* () {
      const limit = context.quick ? 250 : 1000
      const durationMs = context.quick ? 3000 : 20_000
      const results: Array<CaseResult> = []

      for (const [label, actors] of [
        ["at-limit", limit],
        [`over-limit-${OVERSUBSCRIPTION}x`, limit * OVERSUBSCRIPTION],
      ] as const)
        results.push(
          ...(yield* context.withRuntime({ maxResidentActors: limit }, (instruments) =>
            Effect.gen(function* () {
              const parameters = {
                actors,
                workers: WORKERS,
                pool: DEFAULT_POOL,
                maxResidentActors: limit,
                hibernateAfterMs: HIBERNATE_AFTER_MS,
              }

              const order = shuffled(actors)

              const first = yield* measure({
                name: `first-touch-${label}`,
                parameters,
                instruments,
                workers: WORKERS,
                operations: actors,
                operation: (index) => add(order[index]!),
              })

              const activated = yield* activations("SleepyProbe")

              const steady = yield* measure({
                name: `steady-${label}`,
                parameters,
                instruments,
                workers: WORKERS,
                durationMs,
                operation: (index) => add(pick(actors)(index)),
              })

              const cold = (yield* activations("SleepyProbe")) - activated

              const cases: Array<CaseResult> = [
                first,
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

      return results
    }),
}
