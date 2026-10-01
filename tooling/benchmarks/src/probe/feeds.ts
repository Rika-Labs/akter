import { Actor } from "@rikalabs/akter"
import { Effect, Schema } from "effect"

export const Pinged = Actor.event("Pinged", { n: Schema.Int })

/** Emits that many `Pinged` events in one turn. */
export const Ping = Actor.command("Ping", { payload: Schema.Int })

/** An actor whose `Pinged` events are served as an SSE feed. */
export const FeedProbe = Actor.make("FeedProbe", {
  key: Schema.NonEmptyString,
  events: [Pinged],
  feeds: [Pinged],
  api: { Ping },
  access: Actor.access.public,
})

export const FeedProbeLive = FeedProbe.toLayer({
  Ping: Effect.fnUntraced(function* (count: number) {
    const turn = yield* FeedProbe.Turn

    for (let n = 0; n < count; n++) yield* turn.emit(Pinged.make({ n }))
  }),
})
