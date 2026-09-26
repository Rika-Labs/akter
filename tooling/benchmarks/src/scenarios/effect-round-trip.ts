import { Deferred, Effect } from "effect"
import { load } from "../measure.ts"
import { Sender } from "../probe/contract.ts"
import { EffectProbe, roundTrip } from "../probe/effects.ts"
import { deliveries } from "../probe/layer.ts"
import { type CaseResult, measure, type Scenario } from "../scenario.ts"

/** More stalled effects than any runner has executor slots, so every slot stays busy. */
const STALLED = 128

/**
 * A command that performs an effect, the relay running its executor after
 * commit, and the executor's result committed by the `onSuccess` turn. The
 * executor does no I/O, so the time is the framework's.
 */
export const effectRoundTrip: Scenario = {
  name: "effect-round-trip",
  description:
    "Perform an effect, run its executor after commit, and commit its onSuccess turn: one caller for latency, then 64 callers on 64 actors; then intent delivery latency while every executor slot runs a slow effect.",
  multiRunner: true,
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

      const window = quick ? 3000 : 10_000

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.gen(function* () {
            let next = 0

            const send = (sender: Effect.Success<ReturnType<typeof Sender.get>>) =>
              Effect.suspend(() => {
                const id = `slow-${next++}`

                return Effect.gen(function* () {
                  const delivered = yield* Deferred.make<void>()
                  deliveries.set(id, delivered)
                  yield* sender.Send(id)
                  yield* Deferred.await(delivered)
                }).pipe(Effect.ensuring(Effect.sync(() => deliveries.delete(id))))
              })

            const sender = yield* Sender.get("beside-slow")
            yield* send(sender).pipe(Effect.orDie)

            // Each stall outlasts the window, so executors stay blocked while intents are timed.
            yield* Effect.forEach(
              Array.from({ length: STALLED }, (_, index) => index),
              (index) =>
                EffectProbe.get(`stall-${index}`).pipe(
                  Effect.flatMap((probe) => probe.Hold(window + 10_000)),
                  Effect.orDie,
                ),
              { concurrency: 16, discard: true },
            )
            yield* Effect.sleep("500 millis")

            return yield* measure({
              name: "slow-executor-beside-intents",
              parameters: { stalledEffects: STALLED, stallMs: window + 10_000, workers: 1 },
              instruments,
              workers: 1,
              durationMs: window,
              operation: () => send(sender),
            })
          }),
        ),
      )

      return results
    }),
}
