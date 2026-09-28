import { Actor } from "@durable-actors/core"
import { Effect, Layer, Schema } from "effect"

/**
 * Reports one progress frame at once, then returns its key 100 ms later: a
 * frame still in flight when the route commits is dropped, by design.
 */
export class Report extends Actor.effect<Report>()("Report", {
  input: { key: Schema.String },
  success: Schema.String,
  progress: Schema.Struct({ step: Schema.Finite }),
}) {}

const Start = Actor.command("Start", { input: Schema.String })

const Reported = Actor.command("Reported", { input: Schema.String })

/** Receives every `Report` frame of its actor, and the route's broadcast. */
export const Watch = Actor.connection("Watch", {
  server: Schema.String,
  progress: { effects: [Report], to: "all" },
})

/** Receives only the route's broadcast: its actor type opts into no progress. */
export const Plain = Actor.connection("Plain", { server: Schema.String })

const policy = { effects: { Report: { onSuccess: Reported, progressEvery: "50 millis" } } } as const

export const ProgressProbe = Actor.make("ProgressProbe", {
  key: Schema.NonEmptyString,
  effects: [Report],
  api: { Start, Watch },
  internal: { Reported },
  policy,
})

export const QuietProbe = Actor.make("QuietProbe", {
  key: Schema.NonEmptyString,
  effects: [Report],
  api: { Start, Plain },
  internal: { Reported },
  policy,
})

const handlers = { open: () => Effect.void, frame: () => Effect.void }

export const ProgressProbeLive = Layer.mergeAll(
  ProgressProbe.toLayer(
    Effect.succeed({
      Start: Effect.fnUntraced(function* (key: string) {
        yield* (yield* ProgressProbe.Turn).perform(Report.make({ key }))
      }),
      Reported: Effect.fnUntraced(function* (key: string) {
        yield* (yield* ProgressProbe.Turn).broadcast(Watch, key)
      }),
      Watch: handlers,
    }),
  ),
  ProgressProbe.toEffectLayer(
    Effect.succeed({
      Report: Effect.fnUntraced(function* ({ key }) {
        yield* (yield* ProgressProbe.Executor).progress(Report, { step: 1 })
        yield* Effect.sleep("100 millis")

        return key
      }),
    }),
  ),
  QuietProbe.toLayer(
    Effect.succeed({
      Start: Effect.fnUntraced(function* (key: string) {
        yield* (yield* QuietProbe.Turn).perform(Report.make({ key }))
      }),
      Reported: Effect.fnUntraced(function* (key: string) {
        yield* (yield* QuietProbe.Turn).broadcast(Plain, key)
      }),
      Plain: handlers,
    }),
  ),
  QuietProbe.toEffectLayer(
    Effect.succeed({
      Report: Effect.fnUntraced(function* ({ key }) {
        yield* (yield* QuietProbe.Executor).progress(Report, { step: 1 })
        yield* Effect.sleep("100 millis")

        return key
      }),
    }),
  ),
)
