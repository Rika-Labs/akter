import { Actor } from "durable-actors"
import { Effect, Schema } from "effect"

export const Increment = Actor.command("Increment", { input: Schema.Int, output: Schema.Int })

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
  api: { Increment, Checkpoint },
})
