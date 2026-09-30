import { Actor } from "@durable-actors/core"
import { Deferred, Effect, Layer, Schema } from "effect"

/** Returns its key unchanged, so the round trip measures only framework work. */
export const Echo = Actor.job("Echo", {
  payload: { key: Schema.String },
  success: Schema.String,
})

/** Holds an executor slot for `millis` before it returns; the benchmark's slow provider. */
export const Stall = Actor.job("Stall", { payload: { millis: Schema.Int } })

const Enqueue = Actor.command("Enqueue", { payload: Schema.String })

const Hold = Actor.command("Hold", { payload: Schema.Int })

const Delivered = Actor.command("Delivered", { payload: Schema.String })

/**
 * Enqueues `Echo` per command and receives its result through `onSuccess`.
 * Its type name stays `EffectProbe`: the name feeds each actor's placement
 * hash, so renaming it would move the round trip's actors to other shards
 * and change what the committed baselines compare.
 */
export const JobProbe = Actor.make("EffectProbe", {
  key: Schema.NonEmptyString,
  state: Actor.state({
    delivered: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  api: { Enqueue, Hold },
  internal: { Delivered },
  jobs: {
    Echo: { job: Echo, onSuccess: Delivered },
    Stall: { job: Stall, retry: { times: 0 } },
  },
})

/** Round trips waiting for their `Delivered` turn to commit, by key. */
const waiting = new Map<string, Deferred.Deferred<void>>()

const DeliveredPayload = Schema.fromJsonString(Schema.Struct({ value: Schema.String }))

/** Enqueues `Echo` under `key` and waits until its `onSuccess` turn has committed. */
export const roundTrip = ({ actor, key }: { readonly actor: string; readonly key: string }) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>()
    waiting.set(key, done)

    yield* (yield* JobProbe.get(actor)).Enqueue(key)
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

/** Handlers for `JobProbe`, including its job executors. */
export const JobProbeLive = Layer.mergeAll(
  JobProbe.toLayer({
    Enqueue: Effect.fnUntraced(function* (key: string) {
      yield* (yield* JobProbe.Turn).enqueue(Echo.make({ key }))
    }),
    Hold: Effect.fnUntraced(function* (millis: number) {
      yield* (yield* JobProbe.Turn).enqueue(Stall.make({ millis }))
    }),
    Delivered: Effect.fnUntraced(function* () {
      const turn = yield* JobProbe.Turn
      yield* turn.state.set({ delivered: turn.state.delivered + 1 })
    }),
  }),
  JobProbe.toJobLayer({
    Echo: ({ key }) => Effect.succeed(key),
    Stall: ({ millis }) => Effect.sleep(millis),
  }),
)
