import { Effect } from "effect"
import { load } from "../measure.ts"
import { Probe } from "../probe/contract.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

/** One warm actor: turn latency with one caller, then throughput under contention. */
export const hotActor: Scenario = {
  name: "hot-actor",
  description:
    "Warm command turns on one actor: sequential latency, then 8 and 64 concurrent callers competing for its single turn slot.",
  run: (context) =>
    Effect.gen(function* () {
      const results: Array<CaseResult> = []

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const probe = yield* Probe.get("hot")
            yield* load({ workers: 1, operations: 100, operation: () => probe.Add(1) })

            return yield* measure({
              name: "sequential",
              parameters: { actors: 1, workers: 1 },
              instruments,
              workers: 1,
              operations: context.quick ? 300 : 3000,
              operation: () => probe.Add(1),
              listStatements: true,
            })
          }),
        ),
      )

      for (const workers of [8, 64])
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const probe = yield* Probe.get("hot")
              yield* load({ workers: 1, operations: 100, operation: () => probe.Add(1) })

              return yield* measure({
                name: `concurrent-${workers}`,
                parameters: { actors: 1, workers },
                instruments,
                workers,
                durationMs: context.quick ? 2000 : 10_000,
                operation: () => probe.Add(1),
              })
            }),
          ),
        )

      return results
    }),
}
