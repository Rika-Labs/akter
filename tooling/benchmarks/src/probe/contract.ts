import { Actor, RetentionGap, UnknownCursor } from "@durable-actors/core"
import { Effect, Layer, Schema } from "effect"

/** Adds the amount to the count and replies with the new total. */
export const Add = Actor.command("Add", { input: Schema.Int, output: Schema.Int })

/** Stores the payload as state and replies with its length. */
export const Fill = Actor.command("Fill", { input: Schema.String, output: Schema.Int })

/** Counts a payload without storing it, so its size is limited by the request, not by state. */
export const Weigh = Actor.command("Weigh", { input: Schema.String, output: Schema.Int })

/** Current count. */
export const Peek = Actor.query("Peek", { output: Schema.Int })

const state = Actor.state({
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  blob: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
})

/** The measured actor, with every policy at its default; open to the HTTP scenario's callers. */
export const Probe = Actor.make("Probe", {
  key: Schema.NonEmptyString,
  state,
  api: { Add, Fill, Weigh, Peek },
  access: Actor.access.public,
})

/** Hibernates quickly so a later turn measures a cold activation. */
export const SleepyProbe = Actor.make("SleepyProbe", {
  key: Schema.NonEmptyString,
  state,
  api: { Add, Fill, Peek },
  policy: { hibernateAfter: "250 millis" },
})

/** Stays resident for the whole run, so its activations can be counted in the heap. */
export const ResidentProbe = Actor.make("ResidentProbe", {
  key: Schema.NonEmptyString,
  state,
  api: { Add },
  policy: { hibernateAfter: "1 hour" },
})

/** Event emitted by `Emit`, numbered from zero within one call. */
export class Ticked extends Actor.Event<Ticked>()("Ticked", { n: Schema.Int }) {}

/** Emits that many `Ticked` events in one turn and replies with the count. */
export const Emit = Actor.command("Emit", { input: Schema.Int, output: Schema.Int })

/**
 * Reads the whole event stream after the cursor, page by page, and replies
 * with the event count and the last cursor.
 */
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

/** Relay-delivered intent; its handler completes the pending delivery for the payload. */
export const Deliver = Actor.command("Deliver", { input: Schema.String })

/** Receives relay-delivered intents; only System callers reach `Deliver`. */
export const Sink = Actor.make("Sink", {
  key: Schema.NonEmptyString,
  api: {},
  internal: { Deliver },
})

/** Stages one `Deliver` intent to the sink chosen by the id. */
export const Send = Actor.command("Send", { input: Schema.String })

/** Stages one `Deliver` intent per id, all due at `atMs` (epoch milliseconds). */
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

/** Creates the actor by bumping its count, which schedules its cron entry. */
export const Open = Actor.command("Open")

/** Cron handler; records the run in `cronFires`. */
export const Tick = Actor.command("Tick")

/** An actor with one minutely cron entry; `Open` creates it and writes its first tick. */
export const CronProbe = Actor.make("CronProbe", {
  key: Schema.NonEmptyString,
  state,
  api: { Open, Tick },
  policy: { cron: { "* * * * *": Tick } },
})

/**
 * The history of one event: a count, then a unit, then a note.
 */
const V0 = { n: Schema.Int }

const V1 = { count: Schema.Int }

const V2 = { count: Schema.Int, unit: Schema.String }

const V3 = { count: Schema.Int, unit: Schema.String, note: Schema.String }

const steps = [
  Actor.migration(V0, V1, (v0) => ({ count: v0.n }), {
    downcast: (v1) => ({ n: v1.count }),
  }),
  Actor.migration(V1, V2, (v1) => ({ count: v1.count, unit: "items" }), {
    downcast: (v2) => ({ count: v2.count }),
  }),
  Actor.migration(V2, V3, (v2) => ({ ...v2, note: "" }), {
    downcast: ({ count, unit }) => ({ count, unit }),
  }),
]

/** `Emit` for the evolved actors: emits `Tallied` events and replies with the count. */
export const EvolvedEmit = Actor.command("Emit", { input: Schema.Int, output: Schema.Int })

/** `Replay` for the evolved actors. */
export const EvolvedReplay = Actor.query("Replay", {
  input: Schema.optional(Schema.String),
  output: Schema.Struct({ events: Schema.Int, last: Schema.String }),
  errors: [UnknownCursor, RetentionGap],
})

/**
 * An actor type whose `Tallied` events are stored `behind` steps before the
 * current version, so every replayed event passes through that many upcasts.
 */
const evolved = (behind: 0 | 1 | 3) => {
  class Tallied extends Actor.Event<Tallied>()("Tallied", V3, {
    migrations: steps,
    writeVersion: 3 - behind,
  }) {}

  const Probe = Actor.make(`EvolvedProbe${behind}`, {
    key: Schema.NonEmptyString,
    events: [Tallied],
    api: { Emit: EvolvedEmit, Replay: EvolvedReplay },
  })

  const commands = Probe.toLayer(
    Effect.succeed({
      Emit: Effect.fnUntraced(function* (count: number) {
        const turn = yield* Probe.Turn

        for (let n = 0; n < count; n++)
          yield* turn.emit(Tallied.make({ count: n, unit: "items", note: "" }))

        return count
      }),
    }),
  )

  const reads = Probe.toQueryLayer(
    Effect.succeed({
      Replay: Effect.fnUntraced(function* (after: string | undefined) {
        const read = yield* Probe.Read
        let events = 0
        let last = after ?? "0"

        for (;;) {
          const page = yield* read.events(Tallied, { after: last, limit: 10_000 })
          events += page.length
          last = page.at(-1)?.cursor ?? last

          if (page.length < 10_000) return { events, last }
        }
      }),
    }),
  )

  return { Probe, layer: Layer.merge(commands, reads) }
}

/** Evolved actors keyed by how many versions behind the stored events are. */
export const Evolved = { 0: evolved(0), 1: evolved(1), 3: evolved(3) } as const

/** Handlers for every evolved actor. */
export const EvolvedLive = Layer.mergeAll(Evolved[0].layer, Evolved[1].layer, Evolved[3].layer)
