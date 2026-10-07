import { Actor } from "@rikalabs/akter"
import { Effect, Schema } from "effect"

export const Increment = Actor.command("Increment", { payload: Schema.Int, success: Schema.Int })
export const GetCount = Actor.query("GetCount", { success: Schema.Int })

export const Counter = Actor.make("Counter", {
  key: Schema.NonEmptyString,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Increment, GetCount },
  access: Actor.access.public,
  policy: { executionTimeout: "10 seconds" },
})
