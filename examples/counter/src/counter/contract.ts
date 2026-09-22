import { Actor } from "durable-actors"
import { Effect, Schema } from "effect"

// The same declaration and handler run through before/after-commit faults in layer.test.ts.
export const Counter = Actor.make("Counter", {
  id: Schema.NonEmptyString,
  commands: [Actor.command("Increment", { input: Schema.Int, output: Schema.Int })],
  state: { count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) },
})
