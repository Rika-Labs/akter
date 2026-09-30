import { Actor, Anonymous } from "@durable-actors/core"
import { Effect, Schema } from "effect"

/** The count after an increment commits, so a browser can follow it over the event feed. */
export const Incremented = Actor.event("Incremented", {
  amount: Schema.Int,
  count: Schema.Int,
})

/** Adds the amount to the count and replies with the new total. */
export const Increment = Actor.command("Increment", { payload: Schema.Int, success: Schema.Int })

/** Doubles a number in a durable activity, after a durable pause. */
export const Double = Actor.workflow("Double", {
  payload: { value: Schema.Int },
  success: Schema.Int,
  key: ({ value }) => `double-${value}`,
})

/** Workflow step that doubles its input. */
export const Compute = Double.step("compute", { payload: Schema.Int, success: Schema.Int })

/** Durable one-minute pause before the computation. */
export const Pause = Double.sleep("pause")

/** Mints a `Snapshot` of the current count and returns its id. */
export const Checkpoint = Actor.command("Checkpoint", { success: Schema.String })

/** Creating command of `Snapshot`; stores the count. */
export const Record = Actor.command("Record", { payload: Schema.Int })

/** The count the snapshot stored. */
export const Recorded = Actor.query("Recorded", { success: Schema.Int })

/** A snapshot of a counter, created only by the counter turn that minted it. */
export const Snapshot = Actor.make("Snapshot", {
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Record, Recorded },
  createdBy: Record,
})

/**
 * A counter keyed by name, with an integer count that starts at zero. Anyone
 * signed in may use it; a visitor without credentials may not.
 */
export const Counter = Actor.make("Counter", {
  key: Schema.NonEmptyString,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  events: [Incremented],
  feeds: [Incremented],
  api: { Increment, Checkpoint, Double },
  access: ({ caller }) => !Schema.is(Anonymous)(caller),
})
