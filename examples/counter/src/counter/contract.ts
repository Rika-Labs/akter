import { Actor } from "@durable-actors/core"
import { Effect, Schema } from "effect"

export const Increment = Actor.command("Increment", { input: Schema.Int, output: Schema.Int })

export const Counter = Actor.make("Counter", {
  key: Schema.NonEmptyString,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Increment },
})
