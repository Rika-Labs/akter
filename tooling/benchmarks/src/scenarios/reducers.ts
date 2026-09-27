import type { ActorError } from "@durable-actors/core"
import { Effect } from "effect"
import { load } from "../measure.ts"
import { type Negative, ReducerProbe } from "../probe/reducers.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

type Handle = Effect.Success<ReturnType<typeof ReducerProbe.get>>

/**
 * Server reducers on one warm actor. A reducer runs as an ordinary fenced,
 * receipted turn with no handler, so `hot-actor` (a command handler doing the
 * same increment) is the baseline for each sequential case.
 */
export const reducers: Scenario = {
  name: "reducers",
  description:
    "Server reducer turns on one warm actor: a reducer replying the new state, a commutative reducer replying void, a reducer failing with a declared error, and 64 concurrent callers.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const operations = quick ? 300 : 3000
      const durationMs = quick ? 2000 : 10_000

      const cases: ReadonlyArray<{
        readonly name: string
        readonly workers: number
        readonly operation: (probe: Handle) => Effect.Effect<unknown, ActorError | Negative>
      }> = [
        {
          name: "reduce-sequential",
          workers: 1,
          operation: (probe) => probe.Add(1),
        },
        {
          name: "commutative-sequential",
          workers: 1,
          operation: (probe) => probe.Tick(1),
        },
        {
          name: "rejected-sequential",
          workers: 1,
          operation: (probe) => probe.Add(-1).pipe(Effect.catchTag("Negative", () => Effect.void)),
        },
        {
          name: "reduce-concurrent-64",
          workers: 64,
          operation: (probe) => probe.Add(1),
        },
      ]

      const results: Array<CaseResult> = []

      for (const entry of cases)
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const probe = yield* ReducerProbe.get("hot")
              const operation = () => entry.operation(probe)
              yield* load({ workers: 1, operations: 100, operation })

              return yield* measure({
                name: entry.name,
                parameters: { actors: 1, workers: entry.workers },
                instruments,
                workers: entry.workers,
                ...(entry.workers === 1 ? { operations } : { durationMs }),
                operation,
                listStatements: entry.workers === 1,
              })
            }),
          ),
        )

      return results
    }),
}
