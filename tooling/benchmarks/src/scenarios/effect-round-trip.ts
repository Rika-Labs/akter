import { Effect } from "effect"
import { load } from "../measure.ts"
import { roundTrip } from "../probe/effects.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

/**
 * A command that performs an effect, the relay running its executor after
 * commit, and the executor's result committed by the `onSuccess` turn. The
 * executor does no I/O, so the time is the framework's.
 */
export const effectRoundTrip: Scenario = {
  name: "effect-round-trip",
  description:
    "Perform an effect, run its executor after commit, and commit its onSuccess turn: one caller for latency, then 64 callers on 64 actors.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const results: Array<CaseResult> = []

      for (const workers of [1, 64])
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const name = workers === 1 ? "sequential" : `concurrent-${workers}`

              const trip = (phase: string) => (index: number) =>
                roundTrip({ actor: `effects-${index % workers}`, key: `${phase}-${index}` })

              yield* load({ workers, operations: 100, operation: trip("warm") })

              return yield* measure({
                name,
                parameters: { actors: workers, workers },
                instruments,
                workers,
                ...(workers === 1
                  ? { operations: quick ? 100 : 1000 }
                  : { durationMs: quick ? 2000 : 10_000 }),
                operation: trip(name),
                listStatements: workers === 1,
              })
            }),
          ),
        )

      return results
    }),
}
