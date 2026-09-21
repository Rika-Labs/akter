// Singleton implementation: the sweep is the actor's `run` loop, started at boot because the actor is a singleton.
import { DateTime, Duration, Effect } from "effect"
import { Actors } from "../framework/Actor.ts"
import { Reaper } from "./Reaper.ts"

const youngerThan = (age: Duration.Duration) => (at: DateTime.Utc) =>
  Effect.map(DateTime.now, (now) => Duration.isLessThan(DateTime.distance(at, now), age))

export const ReaperLive = Reaper.toLayer({
  Pause: (ctx) => ctx.state.set({ paused: true }),
  Resume: (ctx) => ctx.state.set({ paused: false })
}, {
  // `run` sees the committed snapshot, refreshed after each turn: a `Pause` turn is visible on the next tick
  run: (ctx) =>
    Effect.gen(function*() {
      if (ctx.state.paused) return
      const actors = yield* Actors
      const dead = yield* actors.deadLetters.list({ limit: 100 })
      for (const d of dead) {
        // `ActorRef` has a `toString`, so it interpolates as `Chat/room-1`
        if (yield* youngerThan(Duration.hours(1))(d.at)) {
          yield* actors.deadLetters.retry(d.id)
          yield* Effect.logInfo(`retrying ${d.effect._tag} for ${d.ref} (attempt ${d.attempts + 1})`)
        } else {
          yield* Effect.logWarning(`dead letter ${d.effect._tag} for ${d.ref} after ${d.attempts} attempts`, d.cause)
        }
      }
    }).pipe(
      // `run` must be `Effect<void, never>`: nothing above fails, so no blanket `catchCause` is needed (decision 149)
      Effect.delay("1 minute"),
      Effect.forever
    )
})
