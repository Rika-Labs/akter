// Server file: handlers object form (no services to acquire at activation).
import { Effect } from "effect"
import { CountChanged, Counter, Overflow } from "./Counter.ts"

export const CounterLive = Counter.toLayer({
  Increment: Effect.fn("Counter.Increment")(function*(ctx, amount) {
    if (amount > 1_000) return yield* new Overflow({ max: 1_000 })
    const next = amount // yield* ctx.db.update(counters)…returning() — joined to the turn tx
    yield* ctx.emit(new CountChanged({ count: next }))
    yield* ctx.self.Reset.after("1 hour") // durable timer, committed with this turn
    return next
  }),
  Reset: (ctx) => ctx.emit(new CountChanged({ count: 0 })),
  GetCount: () => Effect.succeed(0)
})
