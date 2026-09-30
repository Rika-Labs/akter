import { Effect } from "effect"
import { Counter } from "./contract.ts"

/** Handlers for `Counter`. */
export const CounterLive = Counter.toLayer({
  Increment: Effect.fn(function* (amount) {
    const turn = yield* Counter.Turn
    yield* turn.state.set({ count: turn.state.count + amount })

    return turn.state.count
  }),
})
