import { Actor } from "durable-actors"
import { Deferred, Effect, Layer, Schema } from "effect"

/** Returns its key unchanged, so the round trip measures only framework work. */
export class Echo extends Actor.effect<Echo>()("Echo", {
  input: { key: Schema.String },
  success: Schema.String,
}) {}

/** Holds an executor slot for `millis` before it returns; the benchmark's slow provider. */
export class Stall extends Actor.effect<Stall>()("Stall", { input: { millis: Schema.Int } }) {}

const Perform = Actor.command("Perform", { input: Schema.String })

const Hold = Actor.command("Hold", { input: Schema.Int })

const Delivered = Actor.command("Delivered", { input: Schema.String })

/** Performs `Echo` per command and receives its result through `onSuccess`. */
export const EffectProbe = Actor.make("EffectProbe", {
  key: Schema.NonEmptyString,
  state: Actor.state({
    delivered: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  effects: [Echo, Stall],
  api: { Perform, Hold },
  internal: { Delivered },
  policy: { effects: { Echo: { onSuccess: Delivered }, Stall: { retry: { times: 0 } } } },
})

/** Round trips waiting for their `Delivered` turn to commit, by key. */
const waiting = new Map<string, Deferred.Deferred<void>>()

const DeliveredPayload = Schema.fromJsonString(Schema.Struct({ value: Schema.String }))

/** Performs `Echo` under `key` and waits until its `onSuccess` turn has committed. */
export const roundTrip = ({ actor, key }: { readonly actor: string; readonly key: string }) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>()
    waiting.set(key, done)

    yield* (yield* EffectProbe.get(actor)).Perform(key)
    yield* Deferred.await(done)
  }).pipe(Effect.ensuring(Effect.sync(() => waiting.delete(key))))

/** Resolves a round trip once the runtime reports that its `Delivered` turn committed. */
export const afterCommit = ({
  command,
  payload,
}: {
  readonly command: string
  readonly payload: string
}) =>
  Effect.gen(function* () {
    if (command !== "Delivered") return

    const { value } = yield* Schema.decodeEffect(DeliveredPayload)(payload).pipe(Effect.orDie)
    const done = waiting.get(value)

    if (done !== undefined) yield* Deferred.succeed(done, undefined)
  })

export const EffectProbeLive = Layer.mergeAll(
  EffectProbe.toLayer(
    Effect.succeed({
      Perform: Effect.fnUntraced(function* (key: string) {
        yield* (yield* EffectProbe.Turn).perform(Echo.make({ key }))
      }),
      Hold: Effect.fnUntraced(function* (millis: number) {
        yield* (yield* EffectProbe.Turn).perform(Stall.make({ millis }))
      }),
      Delivered: Effect.fnUntraced(function* () {
        const turn = yield* EffectProbe.Turn
        yield* turn.state.set({ delivered: turn.state.delivered + 1 })
      }),
    }),
  ),
  EffectProbe.toEffectLayer(
    Effect.succeed({
      Echo: ({ key }) => Effect.succeed(key),
      Stall: ({ millis }) => Effect.sleep(millis),
    }),
  ),
)
