// Contract file: safe to import from clients. No handler code, no server deps.
import { Schema } from "effect"
import { Actor, Commands, Hibernate, Receipts } from "../framework/Actor.ts"

export class CountChanged extends Schema.TaggedClass<CountChanged>()("CountChanged", { count: Schema.Number }) {}
export class Overflow extends Schema.TaggedError<Overflow>()("Overflow", { max: Schema.Number }, { httpApiStatus: 422 }) {}

// positional input (a single schema)
export const Increment = Actor.command("Increment", { input: Schema.Number, output: Schema.Number, errors: [Overflow] })
// no input
export const Reset = Actor.command("Reset")
export const GetCount = Actor.query("GetCount", { output: Schema.Number })

export const Counter = Actor.make("Counter", {
  commands: [Increment, Reset],
  queries: [GetCount],
  events: [CountChanged],
  lifecycle: [Hibernate.after("30 seconds"), Commands.timeout("10 seconds"), Receipts.keep("7 days")]
})
