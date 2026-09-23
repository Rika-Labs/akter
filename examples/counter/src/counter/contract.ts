import { Actor } from "durable-actors"
import { Effect, Schema } from "effect"

export const Increment = Actor.command("Increment", { input: Schema.Int, output: Schema.Int })

export const Counter = Actor.make("Counter", {
  key: Schema.NonEmptyString,
  state: { count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) },
  api: { Increment },
})
