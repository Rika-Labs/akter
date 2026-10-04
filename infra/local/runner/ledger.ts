import { Actor, Anonymous, Intent } from "@rikalabs/akter"
import { Effect, Schema } from "effect"

const Recorded = Actor.event("Recorded", { amount: Schema.Int })

const Adjusted = Actor.event("Adjusted", { amount: Schema.Int })

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

class Unsettled extends Schema.TaggedError<Unsettled>()("Unsettled", {}) {}

const Settle = Actor.job("Settle", { payload: { amount: Schema.Int } })

const Retry = Actor.job("Retry", { payload: { amount: Schema.Int } })

const Later = Actor.job("Later", { payload: { amount: Schema.Int } })

export const Record = Actor.command("Record", { payload: Schema.Int, success: Schema.Int })

export const Adjust = Actor.command("Adjust", { payload: Schema.Int, success: Schema.Int })

export const Note = Actor.command("Note", { payload: Schema.String, success: Schema.String })

export const Refuse = Actor.command("Refuse", { payload: Schema.String, error: Refused })

export const Queue = Actor.command("Queue", { payload: Schema.Int })

export const OpenReview = Actor.command("OpenReview", {
  payload: Schema.String,
  success: Schema.String,
})

const Remind = Actor.command("Remind", { payload: Schema.Int })

export const Review = Actor.workflow("Review", { payload: { ledger: Schema.String } })

const Tally = Review.step("tally", { payload: Schema.String, success: Schema.String })

const CoolOff = Review.sleep("cool-off")

export const Quick = Actor.workflow("Quick", { payload: { ledger: Schema.String } })

export const Doomed = Actor.workflow("Doomed", {
  payload: { ledger: Schema.String },
  error: Refused,
})

/**
 * The actor a locally built example runner serves so a test can read every
 * kind of durable row back through the inspector: `Record` emits an event,
 * enqueues a job that always dead-letters and schedules a reminder an hour
 * out; `Adjust` emits two events of different names; `Note` commits a receipt
 * and nothing else; `Refuse` fails with a declared error; `Queue` enqueues a
 * job that fails and waits an hour to retry and one first due in an hour;
 * `OpenReview` starts a workflow that records one step and then sleeps for an
 * hour, one that completes at once and one that fails at once. A system
 * caller is admitted so the actor's own intents and workflow starts are
 * delivered.
 */
export const Ledger = Actor.make("Ledger", {
  key: Schema.NonEmptyString,
  state: Actor.state({ total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  events: [Recorded, Adjusted],
  jobs: {
    Settle: { job: Settle, retry: { times: 0 } },
    Retry: { job: Retry, retry: { times: 5, backoff: { base: "1 hour", max: "1 hour" } } },
    Later: { job: Later, retry: { times: 0 } },
  },
  api: { Record, Adjust, Note, Refuse, Queue, OpenReview, Review, Quick, Doomed },
  internal: { Remind },
  access: ({ caller }) => !Schema.is(Anonymous)(caller),
})

/** Handlers for `Ledger`: its commands, its workflows and its jobs. */
export const ledgerLayers = [
  Ledger.toLayer({
    Record: Effect.fnUntraced(function* (amount) {
      const turn = yield* Ledger.Turn
      yield* turn.state.set({ total: turn.state.total + amount })
      yield* turn.emit(Recorded.make({ amount }))
      yield* turn.enqueue(Settle.make({ amount }))
      const later = yield* Ledger.intents(turn.id)
      yield* later.Remind(amount).pipe(Intent.after("1 hour"), Intent.key(`remind-${amount}`))

      return turn.state.total
    }),
    Adjust: Effect.fnUntraced(function* (amount) {
      const turn = yield* Ledger.Turn
      yield* turn.state.set({ total: turn.state.total + amount })
      yield* turn.emit(Recorded.make({ amount }))
      yield* turn.emit(Adjusted.make({ amount }))

      return turn.state.total
    }),
    Note: (text) => Effect.succeed(text),
    Refuse: () => Refused.make({}),
    Queue: Effect.fnUntraced(function* (amount) {
      const turn = yield* Ledger.Turn
      yield* turn.enqueue(Retry.make({ amount }))
      yield* turn.enqueue(Later.make({ amount }), { after: "1 hour" })
    }),
    OpenReview: Effect.fnUntraced(function* () {
      const turn = yield* Ledger.Turn
      const later = yield* Ledger.intents(turn.id)
      yield* later.Quick({ ledger: turn.id })
      yield* later.Doomed({ ledger: turn.id })

      return yield* later.Review({ ledger: turn.id })
    }),
    Remind: () => Effect.void,
    Review: Effect.fnUntraced(function* ({ ledger }: { readonly ledger: string }) {
      yield* Tally.run(ledger, (id) => Effect.succeed(`tallied-${id}`))
      yield* CoolOff("1 hour")
    }),
    Quick: () => Effect.void,
    Doomed: () => Refused.make({}),
  }),
  Ledger.toJobLayer({
    Settle: () => Unsettled.make({}),
    Retry: () => Unsettled.make({}),
    Later: () => Effect.void,
  }),
] as const
