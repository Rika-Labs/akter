import { Effect, Schema } from "effect"
import { Actor } from "../../../index.ts"

const Increment = Actor.command("Increment", { input: Schema.Finite, output: Schema.Finite })

export class Incremented extends Actor.Event<Incremented>()("Incremented", {
  count: Schema.Finite,
}) {}

/** Served by a process the parent kills mid-command, then by a fresh one on the same port. */
export const ServedCounter = Actor.make("ServedCounter", {
  key: Schema.String,
  events: [Incremented],
  state: Actor.state({ count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Increment },
})
