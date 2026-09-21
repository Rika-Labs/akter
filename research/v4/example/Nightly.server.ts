// The framework provides System("cron") as the caller, so no `Actor.as` piping is needed here.
import { Effect } from "effect"
import { Counter, CounterId } from "./Counter.ts"
import { Nightly } from "./Nightly.ts"

const ids = ["counter-123", "messages-sent"].map((id) => CounterId.make(id))

export const NightlyLive = Nightly.toLayer(
  Effect.forEach(ids, (id) =>
    Effect.gen(function*() {
      const counter = yield* Counter.get(id)
      yield* counter.Reset()
    }).pipe(Effect.catchCause(Effect.logError)), { discard: true })
)
