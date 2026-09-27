import { Actor, RetentionGap, UnknownCursor } from "@durable-actors/core"
import { Effect, Schema } from "effect"

export const Add = Actor.command("Add", { input: Schema.Int, output: Schema.Int })

export const Fill = Actor.command("Fill", { input: Schema.String, output: Schema.Int })

/** Counts a payload without storing it, so its size is limited by the request, not by state. */
export const Weigh = Actor.command("Weigh", { input: Schema.String, output: Schema.Int })

export const Peek = Actor.query("Peek", { output: Schema.Int })

const state = Actor.state({
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  blob: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
})

/** The measured actor, with every policy at its default. */
export const Probe = Actor.make("Probe", {
  key: Schema.NonEmptyString,
  state,
  api: { Add, Fill, Weigh, Peek },
})

/** Hibernates quickly so a later turn measures a cold activation. */
export const SleepyProbe = Actor.make("SleepyProbe", {
  key: Schema.NonEmptyString,
  state,
  api: { Add, Fill, Peek },
  policy: { hibernateAfter: "250 millis" },
})

export class Ticked extends Actor.Event<Ticked>()("Ticked", { n: Schema.Int }) {}

export const Emit = Actor.command("Emit", { input: Schema.Int, output: Schema.Int })

export const Replay = Actor.query("Replay", {
  input: Schema.optional(Schema.String),
  output: Schema.Struct({ events: Schema.Int, last: Schema.String }),
  errors: [UnknownCursor, RetentionGap],
})

/** Reads one page of events after a cursor. */
export const ReplayPage = Actor.query("ReplayPage", {
  input: Schema.Struct({ after: Schema.String, limit: Schema.Int }),
  output: Schema.Int,
  errors: [UnknownCursor, RetentionGap],
})

/** Emits a given number of events per turn and replays them from a cursor. */
export const EventProbe = Actor.make("EventProbe", {
  key: Schema.NonEmptyString,
  events: [Ticked],
  api: { Emit, Replay, ReplayPage },
})

/** Emits like `EventProbe`, under one-day horizons, so everything seeded as old is prunable. */
export const RetentionProbe = Actor.make("RetentionProbe", {
  key: Schema.NonEmptyString,
  events: [Ticked],
  api: { Emit },
  policy: { keepReceipts: "1 day", keepEvents: "1 day" },
})

export const Deliver = Actor.command("Deliver", { input: Schema.String })

/** Receives relay-delivered intents; only System callers reach `Deliver`. */
export const Sink = Actor.make("Sink", {
  key: Schema.NonEmptyString,
  api: {},
  internal: { Deliver },
})

export const Send = Actor.command("Send", { input: Schema.String })

export const SendAt = Actor.command("SendAt", {
  input: Schema.Struct({ ids: Schema.Array(Schema.String), atMs: Schema.Int }),
})

/** Stages `count` intents due at `atMs`, generating their ids in the handler so the payload stays small. */
export const SendMany = Actor.command("SendMany", {
  input: Schema.Struct({ offset: Schema.Int, count: Schema.Int, atMs: Schema.Int }),
})

/** Stages intents to `Sink` actors, one per id, keyed by the id's sink. */
export const Sender = Actor.make("Sender", {
  key: Schema.NonEmptyString,
  api: { Send, SendAt, SendMany },
})
