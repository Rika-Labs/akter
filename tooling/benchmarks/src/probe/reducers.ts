import { Actor } from "@durable-actors/core"
import { Effect, Result, Schema } from "effect"

export class Negative extends Schema.TaggedError<Negative>()("Negative", {
  amount: Schema.Int,
}) {}

const state = Actor.state({
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

/** Replies with the committed state, and fails with a declared error for a negative amount. */
export const Add = Actor.reducer("Add", {
  state,
  input: Schema.Int,
  errors: [Negative],
  reduce: (current, amount) =>
    amount < 0
      ? Result.fail(Negative.make({ amount }))
      : Result.succeed({ count: current.count + amount }),
})

/** Replies `void` and cannot fail. */
export const Tick = Actor.reducer("Tick", {
  state,
  input: Schema.Int,
  reduce: (current, amount) => Result.succeed({ count: current.count + amount }),
  commutative: { combine: (first, second) => first + second },
})

/** The same counter as `Probe`, changed by server reducers instead of a command handler. */
export const ReducerProbe = Actor.make("ReducerProbe", {
  key: Schema.NonEmptyString,
  state,
  api: { Add, Tick },
})

/** A reducer-only actor registers through `toLayer` with no handlers. */
export const ReducerProbeLive = ReducerProbe.toLayer(Effect.succeed({}))
