import { Effect } from "effect"
import { Counter } from "./contract.ts"

export const CounterLive = Counter.toLayer({
  Increment: Effect.fnUntraced(function* (ctx, amount) {
    yield* ctx.state.set({ count: ctx.state.count + amount })

    return ctx.state.count
  }),
})
