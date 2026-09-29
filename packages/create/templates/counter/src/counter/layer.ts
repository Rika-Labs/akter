import { Effect } from "effect"
import { Counter } from "./contract.ts"

/** Handlers for `Counter`. */
export const CounterLive = Counter.toLayer(
  Effect.succeed({
    Increment: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Counter.Turn
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
  }),
)
