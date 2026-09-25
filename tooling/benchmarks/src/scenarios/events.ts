import { Effect } from "effect"
import { load } from "../measure.ts"
import { EventProbe } from "../probe/contract.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

const perSecond = (count: number, elapsedMs: number) =>
  elapsedMs === 0 ? 0 : Math.round((count / elapsedMs) * 1000)

/**
 * Event append cost is the difference between turns that emit 0, 1, and 10
 * events; replay reads committed events after a cursor, as a tailing reader
 * does, and from the start of a long stream, as a resynchronizing reader does.
 */
export const events: Scenario = {
  name: "events",
  description:
    "Turns emitting 0, 1, and 10 events; replay of the newest 10 events and of a whole stream; 64 concurrent tailing readers over 100 actors.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const turns = quick ? 300 : 2000
      const results: Array<CaseResult> = []

      for (const emitted of [0, 1, 10])
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.gen(function* () {
              const probe = yield* EventProbe.get(`append-${emitted}`)
              yield* load({ workers: 1, operations: 100, operation: () => probe.Emit(emitted) })

              return yield* measure({
                name: `append-${emitted}`,
                parameters: { eventsPerTurn: emitted, actors: 1, workers: 1 },
                instruments,
                workers: 1,
                operations: turns,
                operation: () => probe.Emit(emitted),
                listStatements: true,
              })
            }),
          ),
        )

      const stream = quick ? 1000 : 10_000

      results.push(
        ...(yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const probe = yield* EventProbe.get("stream")
            yield* load({ workers: 1, operations: stream / 100, operation: () => probe.Emit(100) })
            const tail = String(stream - 10)

            const tailing = yield* measure({
              name: `replay-tail-10-of-${stream}`,
              parameters: { streamEvents: stream, replayedEvents: 10, workers: 1 },
              instruments,
              workers: 1,
              operations: quick ? 300 : 3000,
              operation: () => probe.Replay(tail),
              listStatements: true,
            })

            const replays = quick ? 20 : 100

            const whole = yield* measure({
              name: `replay-all-${stream}`,
              parameters: { streamEvents: stream, replayedEvents: stream, workers: 1 },
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

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const actors = 100
            const perActor = 100

            yield* load({
              workers: 16,
              operations: actors,
              operation: (actor) =>
                EventProbe.get(`tail-${actor}`).pipe(
                  Effect.flatMap((probe) => probe.Emit(perActor)),
                ),
            })

            const tail = String(perActor - 10)

            const result = yield* measure({
              name: "replay-tail-10-concurrent-64",
              parameters: { actors, streamEvents: perActor, replayedEvents: 10, workers: 64 },
              instruments,
              workers: 64,
              durationMs: quick ? 2000 : 10_000,
              operation: (index) =>
                EventProbe.get(`tail-${index % actors}`).pipe(
                  Effect.flatMap((probe) => probe.Replay(tail)),
                ),
            })

            return { ...result, extra: { eventsPerSecond: result.throughput * 10 } }
          }),
        ),
      )

      return results
    }),
}
