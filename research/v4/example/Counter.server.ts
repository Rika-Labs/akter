// Server file: handlers object form (no services to acquire at activation).
import { Effect } from "effect"
import { CountChanged, Counter, Overflow } from "./Counter.ts"

export const CounterLive = Counter.toLayer({
  Increment: Effect.fn("Counter.Increment")(function*(ctx, amount) {
    if (amount > 1_000) return yield* new Overflow({ max: 1_000 })
    const next = amount // yield* ctx.db.update(counters)…returning() — joined to the turn tx
    yield* ctx.emit(new CountChanged({ count: next }))
    // durable timer, committed with this turn; the key makes it replaceable and cancellable
    yield* ctx.self.Reset.after("1 hour", { key: "idle" })
    return next
  }),
  Reset: Effect.fn("Counter.Reset")(function*(ctx) {
    yield* ctx.timers.cancel("idle")
    yield* ctx.emit(new CountChanged({ count: 0 }))
  }),
  GetCount: () => Effect.succeed(0)
}, {
  lifecycle: [
    Counter.onCreate((ctx) => Effect.logInfo(`counter created: ${ctx.id}`)),
    Counter.onSleep((ctx) => Effect.logInfo(`counter sleeping: ${ctx.id}`))
  ]
})
