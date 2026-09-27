import { Effect } from "effect"
import { Compute, Counter, Pause } from "./contract.ts"

export const CounterLive = Counter.toLayer(
  Effect.succeed({
    Increment: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Counter.Turn
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
    Double: Effect.fnUntraced(function* ({ value }: { readonly value: number }) {
      yield* Pause("1 minute")

      return yield* Compute.run(value, (input) => Effect.succeed(input * 2))
    }),
  }),
)
