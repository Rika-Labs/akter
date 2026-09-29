import { Actor } from "@durable-actors/core"
import { Effect, Schema } from "effect"

/** The count after an increment commits, so a browser can follow it over the event feed. */
export class Incremented extends Actor.Event<Incremented>()("Incremented", {
  amount: Schema.Int,
  count: Schema.Int,
}) {}

/** Adds the amount to the count and replies with the new total. */
export const Increment = Actor.command("Increment", { input: Schema.Int, output: Schema.Int })

/** Doubles a number in a durable activity, after a durable pause. */
export const Double = Actor.workflow("Double", {
  input: { value: Schema.Int },
  output: Schema.Int,
  key: ({ value }) => `double-${value}`,
})

/** Workflow step that doubles its input. */
export const Compute = Double.step("compute", { input: Schema.Int, success: Schema.Int })

/** Durable one-minute pause before the computation. */
export const Pause = Double.sleep("pause")

/** Mints a `Snapshot` of the current count and returns its id. */
export const Checkpoint = Actor.command("Checkpoint", { output: Schema.String })

/** Creating command of `Snapshot`; stores the count. */
export const Record = Actor.command("Record", { input: Schema.Int })

/** The count the snapshot stored. */
export const Recorded = Actor.query("Recorded", { output: Schema.Int })

/** A snapshot of a counter, created only by the counter turn that minted it. */
export const Snapshot = Actor.make("Snapshot", {
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Record, Recorded },
  policy: { createdBy: Record },
})

/** A counter keyed by name, with an integer count that starts at zero. */
export const Counter = Actor.make("Counter", {
  key: Schema.NonEmptyString,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  events: [Incremented],
  feeds: [Incremented],
  api: { Increment, Checkpoint, Double },
})
