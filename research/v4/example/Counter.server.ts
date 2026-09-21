// Server file: handlers object form (no services to acquire at activation).
import { Effect } from "effect"
import { CountChanged, Counter, Overflow } from "./Counter.ts"

export const CounterLive = Counter.toLayer({
  Increment: Effect.fn(function*(ctx, amount) {
    const next = ctx.state.count + amount // synchronous read of keyed state
    if (next > 1_000) return yield* new Overflow({ max: 1_000 })
    yield* ctx.state.set({ count: next }) // only the dirty key is written at commit
    yield* ctx.emit(new CountChanged({ count: next }))
    // durable timer, committed with this turn; the key makes it replaceable and cancellable
    yield* ctx.self.Reset.after("1 hour", { key: "idle" })
    return next
  }),
  Reset: Effect.fn(function*(ctx) {
    yield* ctx.timers.cancel("idle")
    yield* ctx.state.set({ count: 0, lastReset: ctx.now })
    yield* ctx.emit(new CountChanged({ count: 0 }))
  })
}, {
  // actor/id/commandId are annotated by the framework (decision 112), so nothing interpolates ids here
  hooks: [
    Counter.onCreate(() => Effect.logInfo("counter created")),
    Counter.onSleep(() => Effect.logInfo("counter sleeping"))
  ]
})

// committed snapshot on the caller's node: no activation, no cluster hop
export const CounterReads = Counter.toQueryLayer({
  GetCount: (ctx) => Effect.succeed(ctx.state.count)
})
