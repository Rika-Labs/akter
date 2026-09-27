import { Actor } from "@durable-actors/core"
import { Effect, Schema } from "effect"

export const Flow = Actor.workflow("Flow", {
  input: { key: Schema.String, steps: Schema.Int, sleepMs: Schema.Int },
  output: Schema.Int,
  key: ({ key }) => key,
})

const steps = ["a", "b", "c", "d"].map((name) =>
  Flow.step(name, { input: Schema.Int, success: Schema.Int }),
)

const Pause = Flow.sleep("pause")

/** Runs up to four named activity steps and an optional durable sleep. */
export const WorkflowProbe = Actor.make("WorkflowProbe", {
  key: Schema.NonEmptyString,
  api: { Flow },
})

export const WorkflowProbeLive = WorkflowProbe.toLayer(
  Effect.succeed({
    Flow: Effect.fnUntraced(function* (input: {
      readonly key: string
      readonly steps: number
      readonly sleepMs: number
    }) {
      let total = 0

      for (const step of steps.slice(0, input.steps))
        total = yield* step.run(total, (value) => Effect.succeed(value + 1))

      if (input.sleepMs > 0) yield* Pause(`${input.sleepMs} millis`)

      return total
    }),
  }),
)
