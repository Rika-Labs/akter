// Contract file: safe to import from clients. No handler code, no server deps.
import { Effect, Schema } from "effect"
import { Actor, Commands, Cron, Hibernate, Receipts, State } from "../framework/Actor.ts"

// branded id: `Counter.get("c1")` does not compile, `Counter.get(CounterId.make("c1"))` does
export const CounterId = Schema.String.pipe(Schema.brand("CounterId"))
export type CounterId = typeof CounterId.Type

export class CountChanged extends Schema.TaggedClass<CountChanged>()("CountChanged", { count: Schema.Number }) {}

// no `httpApiStatus`: a declared error defaults to 422 on HTTP
export class Overflow extends Schema.TaggedError<Overflow>()("Overflow", { max: Schema.Number }) {
  override get message(): string {
    return `the counter cannot go above ${this.max}: reset it first`
  }
}

// positional input (a single schema)
export const Increment = Actor.command("Increment", {
  description: "Add `amount` to the counter and return the new value. Fails with Overflow above 1000.",
  input: Schema.Number,
  output: Schema.Number,
  errors: [Overflow]
})
// no input: callable from cron
export const Reset = Actor.command("Reset", {
  description: "Set the counter back to zero. Runs hourly on its own and is safe to call at any time."
})
export const GetCount = Actor.query("GetCount", {
  description: "The committed counter value. Reads the caller's node, never wakes the actor.",
  output: Schema.Number
})

export const Counter = Actor.make("Counter", {
  description: "A monotonic counter. One actor per counter id; the value lives in keyed state.",
  id: CounterId,
  commands: [Increment, Reset],
  queries: [GetCount],
  events: [CountChanged],
  // keyed state: `withDecodingDefault` is the value when the row is absent
  state: {
    count: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    lastReset: Schema.optionalKey(Schema.DateTimeUtc)
  },
  lifecycle: [
    Hibernate.after("30 seconds"),
    Commands.timeout("10 seconds"),
    Receipts.keep("7 days"),
    Cron.every("0 * * * *", Reset),
    State.maxBytes("16 KiB")
  ]
})
