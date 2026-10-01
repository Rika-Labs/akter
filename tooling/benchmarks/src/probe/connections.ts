import { Actor } from "@rikalabs/akter"
import { Effect, Layer, Schema, Stream } from "effect"

/** Echoes each client frame back to its sender. */
export const Feed = Actor.connection("Feed", {
  server: Schema.String,
  client: Schema.String,
})

/** Broadcasts the text to every connection open on the actor. */
export const Shout = Actor.command("Shout", { payload: Schema.String })

/** Event emitted by `Log` and streamed by `Tail`. */
export const Logged = Actor.event("Logged", { text: Schema.String })

/** Emits one `Logged` event; `Tail` subscribers see it once the turn commits. */
export const Log = Actor.command("Log", { payload: Schema.String })

/** Every `Logged` event after the start, then each new one as it commits. */
export const Tail = Actor.stream("Tail", { success: Schema.String })

/** One element, then the end: the cost of a subscription itself. */
export const Once = Actor.stream("Once", { success: Schema.String })

/** One actor whose connections are parked by default; `Shout` broadcasts to all of them. */
export const LiveProbe = Actor.make("LiveProbe", {
  key: Schema.NonEmptyString,
  events: [Logged],
  api: { Feed, Shout, Log, Tail, Once },
})

/** Handlers for `LiveProbe`. */
export const LiveProbeLive = LiveProbe.toLayer({
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
})

/**
 * Reports one progress frame at once, then returns its key 100 ms later: a
 * frame still in flight when the route commits is dropped, by design.
 */
export const Report = Actor.job("Report", {
  payload: { key: Schema.String },
  success: Schema.String,
  progress: Schema.Struct({ step: Schema.Finite }),
})

const Start = Actor.command("Start", { payload: Schema.String })

const Reported = Actor.command("Reported", { payload: Schema.String })

/** Receives every `Report` frame of its actor, and the route's broadcast. */
export const Watch = Actor.connection("Watch", {
  server: Schema.String,
  progress: { jobs: [Report], to: "all" },
})

/** Receives only the route's broadcast: its actor type opts into no progress. */
export const Plain = Actor.connection("Plain", { server: Schema.String })

const jobs = { Report: { job: Report, onSuccess: Reported, progressEvery: "50 millis" } } as const

/** Actor whose route reports progress every 50 ms to its `Watch` connections. */
export const ProgressProbe = Actor.make("ProgressProbe", {
  key: Schema.NonEmptyString,
  api: { Start, Watch },
  internal: { Reported },
  jobs,
})

/**
 * Same route as `ProgressProbe`, but its `Plain` connections receive only the
 * final broadcast.
 */
export const QuietProbe = Actor.make("QuietProbe", {
  key: Schema.NonEmptyString,
  api: { Start, Plain },
  internal: { Reported },
  jobs,
})

const handlers = { open: () => Effect.void, frame: () => Effect.void }

/** Handlers for `ProgressProbe` and `QuietProbe`. */
export const ProgressProbeLive = Layer.mergeAll(
  ProgressProbe.toLayer({
    Start: Effect.fnUntraced(function* (key: string) {
      yield* (yield* ProgressProbe.Turn).enqueue(Report.make({ key }))
    }),
    Reported: Effect.fnUntraced(function* (key: string) {
      yield* (yield* ProgressProbe.Turn).broadcast(Watch, key)
    }),
    Watch: handlers,
  }),
  ProgressProbe.toJobLayer({
    Report: Effect.fnUntraced(function* ({ key }) {
      yield* (yield* ProgressProbe.Executor).progress(Report, { step: 1 })
      yield* Effect.sleep("100 millis")

      return key
    }),
  }),
  QuietProbe.toLayer({
    Start: Effect.fnUntraced(function* (key: string) {
      yield* (yield* QuietProbe.Turn).enqueue(Report.make({ key }))
    }),
    Reported: Effect.fnUntraced(function* (key: string) {
      yield* (yield* QuietProbe.Turn).broadcast(Plain, key)
    }),
    Plain: handlers,
  }),
  QuietProbe.toJobLayer({
    Report: Effect.fnUntraced(function* ({ key }) {
      yield* (yield* QuietProbe.Executor).progress(Report, { step: 1 })
      yield* Effect.sleep("100 millis")

      return key
    }),
  }),
)
