import { Effect } from "effect"
import { load } from "../measure.ts"
import { Evolved } from "../probe/contract.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

const perSecond = (count: number, elapsedMs: number) =>
  elapsedMs === 0 ? 0 : Math.round((count / elapsedMs) * 1000)

/**
 * Replay of a stream whose events were stored at the current payload version,
 * one step behind it, and three steps behind it: the cost of read-time
 * upcasting is the difference between them.
 */
export const eventsReplay: Scenario = {
  name: "events-replay",
  description:
    "Replay of a whole stream and of its newest 10 events, stored at the current payload version and one and three migration steps behind it.",
  run: (context) =>
    Effect.gen(function* () {
      const stream = context.quick ? 1000 : 10_000
      const results: Array<CaseResult> = []

      for (const behind of [0, 1, 3] as const)
        results.push(
          ...(yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const probe = yield* Evolved[behind].Probe.get("stream")
              yield* load({
                workers: 1,
                operations: stream / 100,
                operation: () => probe.Emit(100),
              })

              const tailing = yield* measure({
                name: `replay-tail-10-of-${stream}-behind-${behind}`,
                parameters: {
                  streamEvents: stream,
                  replayedEvents: 10,
                  stepsBehind: behind,
                  workers: 1,
                },
                instruments,
                workers: 1,
                operations: context.quick ? 300 : 3000,
                operation: () => probe.Replay(String(stream - 10)),
              })

              const replays = context.quick ? 20 : 100

              const whole = yield* measure({
                name: `replay-all-${stream}-behind-${behind}`,
                parameters: {
                  streamEvents: stream,
                  replayedEvents: stream,
                  stepsBehind: behind,
                  workers: 1,
                },
                instruments,
                workers: 1,
                operations: replays,
                operation: () => probe.Replay(undefined),
              })

              return [
                tailing,
                {
                  ...whole,
                  extra: { eventsPerSecond: perSecond(replays * stream, whole.elapsedMs) },
                },
              ]
            }),
          )),
        )

      return results
    }),
}
