// Singleton implementation: the framework provides System("singleton") as the caller inside `run`.
import { Effect } from "effect"
import { Actors, Database } from "../framework/Actor.ts"
import { Reaper } from "./Reaper.ts"

const purgeOnce = Effect.gen(function*() {
  // the escape hatch: the framework's own tables are ordinary SQL
  const { sql } = yield* Database
  yield* sql`DELETE FROM actor_receipts WHERE at < now() - interval '7 days'`
  const actors = yield* Actors
  const dead = yield* actors.deadLetters.list({ limit: 100 })
  // `ActorRef` has a `toString`, so it interpolates as `Chat/room-1`
  yield* Effect.forEach(dead, (d) => Effect.logWarning(`dead letter ${d.effect._tag} for ${d.ref} after ${d.attempts} attempts`))
}).pipe(Effect.catchCause(Effect.logError)) // `run` must not fail: a bad sweep is logged, not fatal

export const ReaperLive = Reaper.toLayer(Effect.forever(purgeOnce.pipe(Effect.delay("1 minute"))))
