import { Actor } from "@durable-actors/core"
import { Deferred, Effect, Schema } from "effect"

/** Holds an executor for the provider's latency; no cap. */
export const Work = Actor.job("Work", {
  payload: { label: Schema.String },
  success: Schema.String,
})

/** `Work` with at most two running attempts per actor. */
export const PairWork = Actor.job("PairWork", {
  payload: { label: Schema.String },
  success: Schema.String,
})

/** `Work` with one running attempt per actor. */
export const SingleWork = Actor.job("SingleWork", {
  payload: { label: Schema.String },
  success: Schema.String,
})

/** Runs until it is interrupted; enqueued under its label as key and cancelled. */
export const Hang = Actor.job("Hang", {
  payload: { label: Schema.String },
  success: Schema.String,
})

/** Names of the jobs `ControlProbe` can enqueue. */
export const ControlJob = Schema.Literals(["Work", "PairWork", "SingleWork", "Hang"])

/** Name of one job `ControlProbe` can enqueue. */
export type ControlJob = typeof ControlJob.Type

const EnqueueAll = Actor.command("EnqueueAll", {
  payload: Schema.Struct({ job: ControlJob, labels: Schema.Array(Schema.String) }),
})

const CancelAll = Actor.command("CancelAll", { payload: Schema.Array(Schema.String) })

const Finished = Actor.command("Finished", { payload: Schema.String })

const HangCancelled = Actor.command("HangCancelled", { payload: Actor.Cancelled(Hang) })

/** Enqueues a batch of jobs in one turn and cancels keyed ones in another. */
export const ControlProbe = Actor.make("ControlProbe", {
  key: Schema.NonEmptyString,
  state: Actor.state({
    finished: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  api: { EnqueueAll, CancelAll },
  internal: { Finished, HangCancelled },
  jobs: {
    Work: { job: Work, onSuccess: Finished },
    PairWork: { job: PairWork, concurrency: { perActor: 2 }, onSuccess: Finished },
    SingleWork: { job: SingleWork, concurrency: { perActor: 1 }, onSuccess: Finished },
    Hang: {
      job: Hang,
      retry: { times: 0 },
      timeout: "5 minutes",
      onCancelled: HangCancelled,
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
export const ControlProbeCommands = ControlProbe.toLayer({
  EnqueueAll: Effect.fnUntraced(function* ({ job, labels }) {
    const turn = yield* ControlProbe.Turn
    const Declared = { Work, PairWork, SingleWork, Hang }[job]

    for (const label of labels)
      yield* turn.enqueue(Declared.make({ label }), job === "Hang" ? { key: label } : {})
  }),
  CancelAll: Effect.fnUntraced(function* (keys) {
    const turn = yield* ControlProbe.Turn

    for (const key of keys) yield* turn.cancelJob(key)
  }),
  Finished: Effect.fnUntraced(function* () {
    const turn = yield* ControlProbe.Turn
    yield* turn.state.set({ finished: turn.state.finished + 1 })
  }),
  HangCancelled: Effect.fnUntraced(function* () {
    const turn = yield* ControlProbe.Turn
    yield* turn.state.set({ finished: turn.state.finished + 1 })
  }),
})

/** The fake provider: `latencyMs` per call, or until interrupted for `Hang`. */
export const controlProbeJobs = (latencyMs: number) => {
  const call = (label: string) =>
    Effect.gen(function* () {
      const { ref } = yield* ControlProbe.Executor
      yield* began(label, ref.id)
      yield* Effect.sleep(latencyMs)

      return label
    }).pipe(Effect.ensuring(ended(label)))

  return ControlProbe.toJobLayer({
    Work: ({ label }) => call(label),
    PairWork: ({ label }) => call(label),
    SingleWork: ({ label }) => call(label),
    Hang: ({ label }) =>
      Effect.gen(function* () {
        const { ref } = yield* ControlProbe.Executor
        yield* began(label, ref.id)

        return yield* Effect.never
      }).pipe(Effect.ensuring(ended(label))),
  })
}
