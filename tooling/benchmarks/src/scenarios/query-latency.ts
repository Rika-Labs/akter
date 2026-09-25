import { Effect } from "effect"
import { load } from "../measure.ts"
import { Probe } from "../probe/contract.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

/** Queries read committed rows on the caller's node: no activation, fence, or receipt. */
export const queryLatency: Scenario = {
  name: "query-latency",
  description:
    "Query handler reads of committed state: sequential on one actor, then 64 concurrent callers over 1k actors.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const results: Array<CaseResult> = []

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const probe = yield* Probe.get("read")
            yield* probe.Add(1).pipe(Effect.orDie)
            yield* load({ workers: 1, operations: 100, operation: () => probe.Peek() })

            return yield* measure({
              name: "sequential",
              parameters: { actors: 1, workers: 1 },
              instruments,
              workers: 1,
              operations: quick ? 300 : 3000,
              operation: () => probe.Peek(),
              listStatements: true,
            })
          }),
        ),
      )

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const actors = 1000

            const peek = (actor: number) =>
              Probe.get(`read-${actor % actors}`).pipe(Effect.flatMap((probe) => probe.Peek()))

            yield* load({
              workers: 32,
              operations: actors,
              operation: (actor) =>
                Probe.get(`read-${actor}`).pipe(Effect.flatMap((probe) => probe.Add(1))),
            })

            return yield* measure({
              name: "concurrent-64",
              parameters: { actors, workers: 64 },
              instruments,
              workers: 64,
              durationMs: quick ? 2000 : 10_000,
              operation: peek,
            })
          }),
        ),
      )

      return results
    }),
}
