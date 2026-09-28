import { Actor } from "@durable-actors/core"
import { Effect, Schema, Stream } from "effect"

/** Echoes each client frame back to its sender. */
export const Feed = Actor.connection("Feed", {
  server: Schema.String,
  client: Schema.String,
})

export const Shout = Actor.command("Shout", { input: Schema.String })

export class Logged extends Actor.Event<Logged>()("Logged", { text: Schema.String }) {}

/** Emits one `Logged` event; `Tail` subscribers see it once the turn commits. */
export const Log = Actor.command("Log", { input: Schema.String })

/** Every `Logged` event after the start, then each new one as it commits. */
export const Tail = Actor.stream("Tail", { output: Schema.String })

/** One element, then the end: the cost of a subscription itself. */
export const Once = Actor.stream("Once", { output: Schema.String })

/** One actor whose connections are parked by default; `Shout` broadcasts to all of them. */
export const LiveProbe = Actor.make("LiveProbe", {
  key: Schema.NonEmptyString,
  events: [Logged],
  api: { Feed, Shout, Log, Tail, Once },
})

export const LiveProbeLive = LiveProbe.toLayer(
  Effect.succeed({
    Shout: Effect.fnUntraced(function* (text: string) {
      const turn = yield* LiveProbe.Turn
      yield* turn.broadcast(Feed, text)
    }),
    Log: Effect.fnUntraced(function* (text: string) {
      const turn = yield* LiveProbe.Turn
      yield* turn.emit(Logged.make({ text }))
    }),
    Tail: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const read = yield* LiveProbe.Read

          return read.follow(Logged).pipe(
            Stream.map((entry) => entry.event.text),
            Stream.orDie,
          )
        }),
      ),
    Once: () => Stream.succeed("once"),
    Feed: {
      open: () => Effect.void,
      frame: Effect.fnUntraced(function* (frame: string) {
        const conn = yield* LiveProbe.Connection
        yield* conn.send(frame)
      }),
    },
  }),
)
