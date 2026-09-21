// The cron tick is a turn: the caller is `System("cron")`, so no `Actor.as` piping is needed here.
import { Effect } from "effect"
import { Counter, CounterId } from "./Counter.ts"
import { Nightly } from "./Nightly.ts"

const ids = ["counter-123", "messages-sent"].map((id) => CounterId.make(id))

export const NightlyLive = Nightly.toLayer({
  // inside a turn other actors are reachable only as durable intents: the resets commit with this turn and are
  // delivered after it, so a crash mid-loop replays the tick, never half of it
  ResetAll: (ctx) => Effect.forEach(ids, (id) => ctx.actors.get(Counter, id).Reset.send(), { discard: true })
})
