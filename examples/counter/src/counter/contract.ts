import { Actor } from "@durable-actors/core"
import { Effect, Schema } from "effect"

export const Increment = Actor.command("Increment", { input: Schema.Int, output: Schema.Int })

/** Doubles a number in a durable activity, after a durable pause. */
export const Double = Actor.workflow("Double", {
  input: { value: Schema.Int },
  output: Schema.Int,
  key: ({ value }) => `double-${value}`,
})

export const Compute = Double.step("compute", { input: Schema.Int, success: Schema.Int })

export const Pause = Double.sleep("pause")

export const Checkpoint = Actor.command("Checkpoint", { output: Schema.String })

export const Record = Actor.command("Record", { input: Schema.Int })

export const Recorded = Actor.query("Recorded", { output: Schema.Int })

/** A snapshot of a counter, created only by the counter turn that minted it. */
export const Snapshot = Actor.make("Snapshot", {
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Record, Recorded },
  policy: { createdBy: Record },
})

export const Counter = Actor.make("Counter", {
  key: Schema.NonEmptyString,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Increment, Checkpoint, Double },
})
