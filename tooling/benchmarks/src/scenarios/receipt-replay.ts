import { Effect } from "effect"
import { load } from "../measure.ts"
import { Probe } from "../probe/contract.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

/**
 * A same-id retry of a committed command. The handle reuses its command id,
 * so the second run resolves the stored receipt instead of executing a turn.
 */
export const receiptReplay: Scenario = {
  name: "receipt-replay",
  description:
    "Same-command-id retries of committed commands: sequential replay latency, then 64 concurrent replayers.",
  run: (context) =>
    context.withRuntime({}, (instruments) =>
      Effect.gen(function* () {
        const commands = context.quick ? 100 : 1000

        const probes = yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
          Probe.get(`replay-${index}`),
        )

        const calls = Array.from({ length: commands }, (_, index) => probes[index % 100]!.Add(1))

        yield* load({ workers: 16, operations: commands, operation: (index) => calls[index]! })

        const results: Array<CaseResult> = [
          yield* measure({
            name: "sequential",
            parameters: { commands, actors: 100, workers: 1 },
            instruments,
            workers: 1,
            operations: commands,
            operation: (index) => calls[index]!,
            listStatements: true,
          }),
          yield* measure({
            name: "concurrent-64",
            parameters: { commands, actors: 100, workers: 64 },
            instruments,
            workers: 64,
            durationMs: context.quick ? 2000 : 10_000,
            operation: (index) => calls[index % commands]!,
          }),
        ]

        return results
      }),
    ),
}
