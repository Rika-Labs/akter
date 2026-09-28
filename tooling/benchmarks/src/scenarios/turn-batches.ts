import { Deferred, Effect, Fiber } from "effect"
import { BatchProbe, expectArrivals, gate } from "../probe/batches.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

/** Commands that wait behind one held turn, the most one batch takes. */
const WAITING = 32

/**
 * Turn batches on one warm actor. Each operation holds one turn open, queues
 * 32 commands behind it, and releases it: the held turn commits alone, and
 * the 32 waiting commands commit as one batch. Every round forms the same
 * batch, so its statements and round trips are exact; unbatched, the same 33
 * commands cost 33 `hot-actor/sequential` turns.
 */
export const turnBatches: Scenario = {
  name: "turn-batches",
  description:
    "One held turn and 32 commands already waiting behind it, per operation: the held turn commits alone, then the 32 commit as one turn batch.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"

      const result: CaseResult = yield* context.withRuntime({}, (instruments) =>
        Effect.gen(function* () {
          const probe = yield* BatchProbe.get("batched")
          yield* Effect.orDie(probe.Add(1))

          const round = (index: number) =>
            Effect.gen(function* () {
              const opened = gate(`round-${index}`)
              const held = yield* Effect.forkChild(probe.Hold(`round-${index}`))
              yield* Deferred.await(opened.started)
              const arrived = expectArrivals({ actorId: probe.ref.id, target: WAITING })

              const waiting = yield* Effect.forkChild(
                Effect.all(
                  Array.from({ length: WAITING }, () => probe.Add(1)),
                  { concurrency: "unbounded" },
                ),
              )

              yield* arrived
              yield* Deferred.succeed(opened.release, undefined)
              yield* Fiber.join(held)

              return yield* Fiber.join(waiting)
            })

          return yield* measure({
            name: `waiting-${WAITING}`,
            parameters: { actors: 1, waiting: WAITING },
            instruments,
            workers: 1,
            operations: quick ? 30 : 300,
            operation: round,
          })
        }),
      )

      return [result]
    }),
}
