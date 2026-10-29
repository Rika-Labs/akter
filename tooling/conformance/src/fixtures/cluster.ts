import { Effect, Schema } from "effect"
import { Actor, JobFailure } from "../../../../packages/akter/src/index.ts"
import { DurableClock } from "../../../../packages/akter/src/server.ts"

const Work = Schema.Struct({ to: Schema.String, amount: Schema.Int, delay: Schema.Int })

/** Asymmetric totals expose duplicate delivery, timer loss and replay from default state. */
export const Ledger = Actor.make("ProcessLedger", {
  state: Schema.Struct({
    total: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    deliveries: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  commands: {
    add: Actor.command(Schema.Finite, { success: Schema.Finite }),
    send: Actor.command(Schema.Struct({ to: Schema.String, amount: Schema.Finite })),
    receive: Actor.command(Schema.Finite, { internal: true }),
    remind: Actor.command(Schema.Struct({ at: Schema.Finite, amount: Schema.Finite })),
    submit: Actor.command(Work),
    rejected: Actor.command(JobFailure, { internal: true }),
  },
  jobs: { work: Actor.job({ payload: Work, onFailure: "rejected" }) },
})

export const LedgerLive = Ledger.toLayer({
  add: (ledger, amount) => {
    ledger.total += amount
    return ledger.total
  },
  send: (_, { to, amount }, { send }) => {
    send(Ledger, to).receive(amount)
  },
  receive: (ledger, amount) => {
    ledger.total += amount
    ledger.deliveries++
  },
  remind: (_, { at, amount }, { schedule }) => {
    schedule({ at }).receive(amount)
  },
  submit: (_, work, { start }) => {
    start.work(work)
  },
  rejected: () => {},
  work: ({ to, amount, delay }, { self, step }) =>
    Effect.gen(function* () {
      const receiver = yield* Ledger.client(to)
      yield* step("credit", receiver.add(amount))
      yield* DurableClock.sleep({ name: "pause", duration: delay })
      yield* self.add(11)
    }).pipe(Effect.scoped),
})

/** Each transition has an independently named actor and one persisted pending cron tick. */
export const Spring = Actor.make("ProcessSpring", {
  state: Schema.Struct({ ticks: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  commands: {
    touch: Actor.command(),
    tick: Actor.command({ cron: "CRON_TZ=America/New_York 30 2 * * *" }),
  },
})

export const Autumn = Actor.make("ProcessAutumn", {
  state: Schema.Struct({ ticks: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  commands: {
    touch: Actor.command(),
    tick: Actor.command({ cron: "CRON_TZ=America/New_York 30 1 * * *" }),
  },
})

export const SpringLive = Spring.toLayer({
  touch: () => {},
  tick: (actor) => {
    actor.ticks++
  },
})
export const AutumnLive = Autumn.toLayer({
  touch: () => {},
  tick: (actor) => {
    actor.ticks++
  },
})

export const SHARDS = 4

export const Request = Schema.Union([
  Schema.TaggedStruct("Status", {}),
  Schema.TaggedStruct("Mint", {}),
  Schema.TaggedStruct("Call", {
    commandId: Schema.String,
    actor: Schema.String,
    key: Schema.String,
    member: Schema.String,
    payload: Schema.Json,
    drop: Schema.optional(Schema.Boolean),
  }),
  Schema.TaggedStruct("State", { actor: Schema.String, key: Schema.String }),
  Schema.TaggedStruct("Drain", {}),
  Schema.TaggedStruct("Clock", { at: Schema.Finite }),
  Schema.TaggedStruct("HoldJobReply", {}),
  Schema.TaggedStruct("Bulk", { key: Schema.String, count: Schema.Int }),
]).pipe(Schema.toTaggedUnion("_tag"))

export const Options = Schema.Struct({
  url: Schema.String,
  directory: Schema.optional(Schema.String),
  prefix: Schema.String,
  writer: Schema.String,
  deployment: Schema.String,
  advertised: Schema.Int,
  listen: Schema.Int,
  bundle: Schema.String,
  at: Schema.optional(Schema.Finite),
  short: Schema.Boolean,
})

export const Status = Schema.Struct({
  ready: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  pid: Schema.Int,
  now: Schema.Finite,
  checkpointReady: Schema.Array(Schema.Boolean),
  shards: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      status: Schema.String,
      refusal: Schema.optional(Schema.String),
      assigned: Schema.Boolean,
      nextDue: Schema.NullOr(Schema.Finite),
      replayMs: Schema.NullOr(Schema.Finite),
    }),
  ),
})

export const State = Schema.Record(Schema.String, Schema.Json)
export const Call = Schema.Struct({ reply: Schema.Json, replayed: Schema.Boolean })
export const Drain = Schema.Struct({
  outcome: Schema.Literals(["clean", "timedOut"]),
  checkpointReady: Schema.Array(Schema.Boolean),
  shards: Schema.Array(
    Schema.Struct({
      shard: Schema.Int,
      offset: Schema.Finite,
      nextDue: Schema.NullOr(Schema.Finite),
    }),
  ),
})
export const Bulk = Schema.Struct({
  count: Schema.Int,
  elapsedMs: Schema.Finite,
  lastId: Schema.String,
  lastAmount: Schema.Finite,
})
export const Mint = Schema.Struct({ commandId: Schema.String })
export const ClockSet = Schema.Struct({ now: Schema.Finite })
