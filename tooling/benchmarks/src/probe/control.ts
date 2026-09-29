import { Actor } from "@durable-actors/core"
import { Deferred, Effect, Schema } from "effect"

/** Holds an executor for the provider's latency; no cap. */
export class Work extends Actor.effect<Work>()("Work", {
  input: { label: Schema.String },
  success: Schema.String,
}) {}

/** `Work` with at most two running attempts per actor. */
export class PairWork extends Actor.effect<PairWork>()("PairWork", {
  input: { label: Schema.String },
  success: Schema.String,
}) {}

/** `Work` with one running attempt per actor. */
export class SingleWork extends Actor.effect<SingleWork>()("SingleWork", {
  input: { label: Schema.String },
  success: Schema.String,
}) {}

/** Runs until it is interrupted; performed under its label as key and cancelled. */
export class Hang extends Actor.effect<Hang>()("Hang", {
  input: { label: Schema.String },
  success: Schema.String,
}) {}

/** Names of the effects `ControlProbe` can perform. */
export const ControlEffect = Schema.Literals(["Work", "PairWork", "SingleWork", "Hang"])

/** Name of one effect `ControlProbe` can perform. */
export type ControlEffect = typeof ControlEffect.Type

const PerformAll = Actor.command("PerformAll", {
  input: Schema.Struct({ effect: ControlEffect, labels: Schema.Array(Schema.String) }),
})

const CancelAll = Actor.command("CancelAll", { input: Schema.Array(Schema.String) })

const Finished = Actor.command("Finished", { input: Schema.String })

const HangCancelled = Actor.command("HangCancelled", { input: Actor.Cancelled(Hang) })

/** Performs a batch of effects in one turn and cancels keyed ones in another. */
export const ControlProbe = Actor.make("ControlProbe", {
  key: Schema.NonEmptyString,
  state: Actor.state({
    finished: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  effects: [Work, PairWork, SingleWork, Hang],
  api: { PerformAll, CancelAll },
  internal: { Finished, HangCancelled },
  policy: {
    effects: {
      Work: { onSuccess: Finished },
      PairWork: { concurrency: { perActor: 2 }, onSuccess: Finished },
      SingleWork: { concurrency: { perActor: 1 }, onSuccess: Finished },
      Hang: { retry: { times: 0 }, timeout: "5 minutes", onCancelled: HangCancelled },
    },
  },
})

/** What the fake provider saw of one attempt, by label; times are `performance.now()`. */
export interface ControlAttempt {
  readonly actor: string
  readonly startedAt: number
  endedAt: number | undefined
}

/** Attempts the fake provider has seen, by label. */
export const controlAttempts = new Map<string, ControlAttempt>()

/** Resolved when every attempt a case waits on has ended. */
export const controlWaiters = new Map<string, Deferred.Deferred<void>>()

const began = (label: string, actor: string) =>
  Effect.sync(() => {
    controlAttempts.set(label, { actor, startedAt: performance.now(), endedAt: undefined })
  })

const ended = (label: string) =>
  Effect.gen(function* () {
    const attempt = controlAttempts.get(label)

    if (attempt !== undefined) attempt.endedAt = performance.now()
    const waiter = controlWaiters.get(label)

    if (waiter !== undefined) yield* Deferred.succeed(waiter, undefined)
  })

/** Handlers for `ControlProbe`. */
export const ControlProbeCommands = ControlProbe.toLayer(
  Effect.succeed({
    PerformAll: Effect.fnUntraced(function* ({ effect, labels }) {
      const turn = yield* ControlProbe.Turn
      const Declared = { Work, PairWork, SingleWork, Hang }[effect]

      for (const label of labels)
        yield* turn.perform(Declared.make({ label }), effect === "Hang" ? { key: label } : {})
    }),
    CancelAll: Effect.fnUntraced(function* (keys) {
      const turn = yield* ControlProbe.Turn

      for (const key of keys) yield* turn.cancelEffect(key)
    }),
    Finished: Effect.fnUntraced(function* () {
      const turn = yield* ControlProbe.Turn
      yield* turn.state.set({ finished: turn.state.finished + 1 })
    }),
    HangCancelled: Effect.fnUntraced(function* () {
      const turn = yield* ControlProbe.Turn
      yield* turn.state.set({ finished: turn.state.finished + 1 })
    }),
  }),
)

/** The fake provider: `latencyMs` per call, or until interrupted for `Hang`. */
export const controlProbeEffects = (latencyMs: number) => {
  const call = (label: string) =>
    Effect.gen(function* () {
      const { ref } = yield* ControlProbe.Executor
      yield* began(label, ref.id)
      yield* Effect.sleep(latencyMs)

      return label
    }).pipe(Effect.ensuring(ended(label)))

  return ControlProbe.toEffectLayer(
    Effect.succeed({
      Work: ({ label }) => call(label),
      PairWork: ({ label }) => call(label),
      SingleWork: ({ label }) => call(label),
      Hang: ({ label }) =>
        Effect.gen(function* () {
          const { ref } = yield* ControlProbe.Executor
          yield* began(label, ref.id)

          return yield* Effect.never
        }).pipe(Effect.ensuring(ended(label))),
    }),
  )
}
