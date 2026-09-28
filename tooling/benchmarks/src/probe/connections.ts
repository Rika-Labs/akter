import { Actor } from "@durable-actors/core"
import { Effect, Schema } from "effect"

/** Echoes each client frame back to its sender. */
export const Feed = Actor.connection("Feed", {
  server: Schema.String,
  client: Schema.String,
})

export const Shout = Actor.command("Shout", { input: Schema.String })

/** One actor whose connections are parked by default; `Shout` broadcasts to all of them. */
export const LiveProbe = Actor.make("LiveProbe", {
  key: Schema.NonEmptyString,
  api: { Feed, Shout },
})

export const LiveProbeLive = LiveProbe.toLayer(
  Effect.succeed({
    Shout: Effect.fnUntraced(function* (text: string) {
      const turn = yield* LiveProbe.Turn
      yield* turn.broadcast(Feed, text)
    }),
    Feed: {
      open: () => Effect.void,
      frame: Effect.fnUntraced(function* (frame: string) {
        const conn = yield* LiveProbe.Connection
        yield* conn.send(frame)
      }),
    },
  }),
)
