import { Actor } from "@durable-actors/core"
import { Effect, Layer, Schema } from "effect"

/** Writes the actor's state, which every `Total` watch reads. */
export const Bump = Actor.command("Bump")

/** The number of bumps so far, watchable. */
export const Total = Actor.query("Total", { success: Schema.Finite, watch: true })

/**
 * One counter whose `Total` is watched. `minInterval` is 1 ms so the cases
 * measure a rerun's own cost, not the default 100 ms pause between two reruns
 * of one watch.
 */
export const WatchProbe = Actor.make("WatchProbe", {
  key: Schema.NonEmptyString,
  state: Actor.state({
    count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  api: { Bump, Total },
  policy: { watch: { minInterval: "1 millis" } },
})

/** Handlers for `WatchProbe`. */
export const WatchProbeLive = Layer.mergeAll(
  WatchProbe.toLayer({
    Bump: Effect.fnUntraced(function* () {
      const turn = yield* WatchProbe.Turn
      yield* turn.state.set({ count: turn.state.count + 1 })
    }),
  }),
  WatchProbe.toQueryLayer({
    Total: Effect.fnUntraced(function* () {
      return (yield* WatchProbe.Read).state.count
    }),
  }),
)
