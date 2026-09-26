import { DateTime, Effect } from "effect"
import { load } from "../measure.ts"
import { Sender } from "../probe/contract.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

/**
 * The baseline that declared subscriptions replace: a publisher that fans out
 * by hand stages one intent per subscriber in its own turn, so its commit
 * grows with the subscriber count. The intents fall due in a day, so only
 * the publisher's turn is timed, never their delivery.
 */
export const subscriptions: Scenario = {
  name: "subscriptions",
  description:
    "Baseline for cross-actor subscriptions: a publisher turn that fans out by staging one intent per subscriber, at 1, 16, 256, and 1,024 subscribers.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const results: Array<CaseResult> = []
      const dueAt = DateTime.toEpochMillis(yield* DateTime.now) + 86_400_000

      for (const subscribers of [1, 16, 256, 1024])
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const publisher = yield* Sender.get(`fanout-${subscribers}`)
              let next = 0

              // The handler generates the ids, so the command payload is the same size at every n.
              const publish = () => {
                const offset = next
                next += subscribers

                return publisher.SendMany({ offset, count: subscribers, atMs: dueAt })
              }

              yield* load({ workers: 1, operations: 10, operation: publish })

              return yield* measure({
                name: `intent-fanout-${subscribers}`,
                parameters: { subscribers, publishers: 1, workers: 1 },
                instruments,
                workers: 1,
                operations: Math.max(
                  20,
                  Math.round((quick ? 20_000 : 200_000) / (subscribers + 99)),
                ),
                operation: publish,
                listStatements: true,
              })
            }),
          ),
        )

      return results
    }),
}
