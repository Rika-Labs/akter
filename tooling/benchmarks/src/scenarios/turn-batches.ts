import { Deferred, Effect, Fiber } from "effect"
import { BatchProbe, expectArrivals, gate } from "../probe/turns/batches.ts"
import type { ActorError } from "@durable-actors/core"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

/** Commands that wait behind one held turn, the most one batch takes. */
const WAITING = 32

/** Commutative calls that wait behind one held turn, the most one merged turn takes. */
const MERGED = 1024

type Probe = Effect.Success<ReturnType<typeof BatchProbe.get>>

/**
 * Turn batches and merged turns on one warm actor. Each operation holds one
 * turn open, queues calls behind it, and releases it: the held turn commits
 * alone, and the waiting calls commit as one batch. `waiting-32` queues 32
 * commands, one batch of 32 turns; `merged-1024` queues 1,024 calls of a
 * commutative reducer, one merged turn with a receipt per call. Every round
 * forms the same batch. A merged round lasts most of a second, long enough
 * for background work to land in it a varying number of times, so that case
 * reports statements and round trips per call (the held turn's included).
 */
export const turnBatches: Scenario = {
  name: "turn-batches",
  description:
    "One held turn and calls already waiting behind it, per operation: 32 commands commit as one turn batch, or 1,024 commutative reducer calls commit as one merged turn.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"

      // One round: hold a turn, queue `waiting` calls behind it, release.
      const rounds = (options: {
        readonly name: string
        readonly waiting: number
        readonly operations: number
        readonly call: (probe: Probe) => Effect.Effect<unknown, ActorError>
        /** Calls a reported statement or round trip is divided over: 1 per round, or the round's calls. */
        readonly calls: number
      }) =>
        context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            const probe = yield* BatchProbe.get(options.name)
            yield* Effect.orDie(probe.Add(1))

            const round = (index: number) =>
              Effect.gen(function* () {
                const opened = gate(`${options.name}-${index}`)
                const held = yield* Effect.forkChild(probe.Hold(`${options.name}-${index}`))
                yield* Deferred.await(opened.started)
                const arrived = expectArrivals({ actorId: probe.ref.id, target: options.waiting })

                const waiting = yield* Effect.forkChild(
                  Effect.all(
                    Array.from({ length: options.waiting }, () => options.call(probe)),
                    { concurrency: "unbounded" },
                  ),
                )

                yield* arrived
                yield* Deferred.succeed(opened.release, undefined)
                yield* Fiber.join(held)

                return yield* Fiber.join(waiting)
              })

            return yield* measure({
              name: options.name,
              parameters: { actors: 1, waiting: options.waiting },
              instruments,
              workers: 1,
              operations: options.operations,
              operation: round,
              calls: options.calls,
            })
          }),
        )

      return [
        yield* rounds({
          name: `waiting-${WAITING}`,
          waiting: WAITING,
          operations: quick ? 30 : 300,
          call: (probe) => probe.Add(1),
          calls: 1,
        }),
        yield* rounds({
          name: `merged-${MERGED}`,
          waiting: MERGED,
          operations: quick ? 10 : 100,
          call: (probe) => probe.Tick(1),
          calls: MERGED + 1,
        }),
      ] satisfies ReadonlyArray<CaseResult>
    }),
}
