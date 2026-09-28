import { Actor } from "@durable-actors/core"
import { Deferred, Effect, Layer, Schema } from "effect"

/** One source commit a benchmark waits to see applied, named by its key. */
export class Pulsed extends Actor.Event<Pulsed>()("Pulsed", {
  reader: Schema.String,
  key: Schema.String,
}) {}

const Pulse = Actor.command("Pulse", {
  input: Schema.Struct({ reader: Schema.String, key: Schema.String }),
})

const PulseMany = Actor.command("PulseMany", {
  input: Schema.Struct({ reader: Schema.String, prefix: Schema.String, count: Schema.Int }),
})

/** Publishes `Pulsed`; routed and dynamic subscribers follow it. */
export const PulseSource = Actor.make("PulseSource", {
  key: Schema.NonEmptyString,
  events: [Pulsed],
  api: { Pulse, PulseMany },
})

/** A source no registered subscriber routes from, for the publisher-cost cases. */
export class Beat extends Actor.Event<Beat>()("Beat", { n: Schema.Int }) {}

const Emit = Actor.command("Emit", { input: Schema.Int })

export const BeatSource = Actor.make("BeatSource", {
  key: Schema.NonEmptyString,
  events: [Beat],
  api: { Emit },
})

const EmitMany = Actor.command("EmitMany", { input: Schema.Int })

/** A source whose events expire after a second, and whose subscribers hold them a second more. */
export const PruneSource = Actor.make("PruneSource", {
  key: Schema.NonEmptyString,
  events: [Beat],
  api: { EmitMany },
  policy: { keepEvents: "1 second", holdEventsForSubscribers: "1 second" },
})

const Applied = Schema.Struct({
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

const Read = Actor.command("Read", {
  input: Actor.Delivery({ source: PulseSource, events: [Pulsed] }),
})

const Routed = Actor.subscription("Routed", {
  source: PulseSource,
  events: [Pulsed],
  handler: Read,
  route: (event) => event.reader,
})

const Touch = Actor.command("Touch")

/** The routed subscriber `Pulsed.reader` names. */
export const PulseReader = Actor.make("PulseReader", {
  key: Schema.NonEmptyString,
  state: Actor.state(Applied.fields),
  api: { Touch },
  internal: { Read },
  subscriptions: [Routed],
})

const OnBeat = Actor.command("OnBeat", {
  input: Actor.Delivery({ source: BeatSource, events: [Beat] }),
})

const Beats = Actor.subscription("Beats", { source: BeatSource, events: [Beat], handler: OnBeat })

const Follow = Actor.command("Follow", { input: Schema.String })

const Unfollow = Actor.command("Unfollow", { input: Schema.String })

/** A dynamic subscriber of `BeatSource`. */
export const BeatFollower = Actor.make("BeatFollower", {
  key: Schema.NonEmptyString,
  state: Actor.state(Applied.fields),
  api: { Follow, Unfollow },
  internal: { OnBeat },
  subscriptions: [Beats],
})

/** Deliveries a benchmark waits for, by the event's key or `follower/n`. */
export const applied = new Map<string, Deferred.Deferred<void>>()

const DeliveredPulse = Schema.fromJsonString(
  Schema.Struct({
    value: Schema.Struct({
      _tag: Schema.String,
      event: Schema.optional(
        Schema.Struct({ key: Schema.optional(Schema.String), n: Schema.optional(Schema.Int) }),
      ),
    }),
  }),
)

/** Resolves a wait once the runtime reports that the delivery's turn committed. */
export const subscriptionCommitted = ({
  ref,
  command,
  payload,
}: {
  readonly ref: { readonly id: string }
  readonly command: string
  readonly payload: string
}) =>
  Effect.gen(function* () {
    if (command !== "Read" && command !== "OnBeat") return

    const { value } = yield* Schema.decodeEffect(DeliveredPulse)(payload).pipe(Effect.orDie)
    const key = command === "Read" ? value.event?.key : `${ref.id}/${value.event?.n}`
    const done = key === undefined ? undefined : applied.get(key)

    if (done !== undefined) yield* Deferred.succeed(done, undefined)
  })

/** Waits until the delivery of `key` has committed; call before the commit that emits it. */
export const awaitApplied = (key: string) =>
  Deferred.make<void>().pipe(
    Effect.tap((done) => Effect.sync(() => applied.set(key, done))),
    Effect.map((done) =>
      Deferred.await(done).pipe(Effect.ensuring(Effect.sync(() => applied.delete(key)))),
    ),
  )

const count = <S extends { readonly count: number }>(turn: {
  readonly state: S & { readonly set: (patch: { readonly count: number }) => Effect.Effect<void> }
}) => turn.state.set({ count: turn.state.count + 1 })

export const SubscriptionProbeLive = Layer.mergeAll(
  PulseSource.toLayer(
    Effect.succeed({
      Pulse: Effect.fnUntraced(function* ({ reader, key }) {
        yield* (yield* PulseSource.Turn).emit(Pulsed.make({ reader, key }))
      }),
      PulseMany: Effect.fnUntraced(function* ({ reader, prefix, count }) {
        const turn = yield* PulseSource.Turn

        for (let index = 0; index < count; index++)
          yield* turn.emit(Pulsed.make({ reader, key: `${prefix}-${index}` }))
      }),
    }),
  ),
  PruneSource.toLayer(
    Effect.succeed({
      EmitMany: Effect.fnUntraced(function* (count: number) {
        const turn = yield* PruneSource.Turn

        for (let n = 0; n < count; n++) yield* turn.emit(Beat.make({ n }))
      }),
    }),
  ),
  BeatSource.toLayer(
    Effect.succeed({
      Emit: Effect.fnUntraced(function* (n: number) {
        yield* (yield* BeatSource.Turn).emit(Beat.make({ n }))
      }),
    }),
  ),
  PulseReader.toLayer(
    Effect.succeed({
      Touch: () => Effect.void,
      Read: Effect.fnUntraced(function* () {
        yield* count(yield* PulseReader.Turn)
      }),
    }),
  ),
  BeatFollower.toLayer(
    Effect.succeed({
      Follow: Effect.fnUntraced(function* (source: string) {
        yield* (yield* BeatFollower.Turn).subscribe(Beats, source)
      }),
      Unfollow: Effect.fnUntraced(function* (source: string) {
        yield* (yield* BeatFollower.Turn).unsubscribe(Beats, source)
      }),
      OnBeat: Effect.fnUntraced(function* () {
        yield* count(yield* BeatFollower.Turn)
      }),
    }),
  ),
)
