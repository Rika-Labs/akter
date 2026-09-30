import { Actor } from "@durable-actors/core"
import { Effect, Schema } from "effect"

/** Adds the amount to the count and replies with the new total. */
export const Increment = Actor.command("Increment", { payload: Schema.Int, success: Schema.Int })

/** A counter keyed by name, holding an integer count that starts at zero. */
export const Counter = Actor.make("Counter", {
  key: Schema.NonEmptyString,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Increment },
})
