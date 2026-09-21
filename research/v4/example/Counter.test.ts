// Typecheck-only sketch of a test file. Same runtime as production; only the edges are swapped.
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { Actor } from "../framework/Actor.ts"
import { ActorTest, Scripts } from "../framework/Testing.ts"
import type { Model } from "../framework/Testing.ts"
import { CountChanged, Counter, CounterId, Overflow } from "./Counter.ts"
import { CounterLive, CounterReads } from "./Counter.server.ts"
import { UserId } from "./Principal.ts"

const principal = { userId: UserId.make("u1"), roles: ["member"] as const }

// one layer per describe block: fresh tenant, in-memory cluster, PGlite, held effects, Anonymous caller
const TestLive = Layer.mergeAll(CounterLive, CounterReads).pipe(Layer.provideMerge(ActorTest.layer()))

it.layer(TestLive)("Counter", (it) => {
  it.effect("a turn commits its event, its timer and its receipt together", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = CounterId.make("c1")
      const counter = yield* Counter.get(id)

      const n = yield* counter.Increment(3)
      expect(n).toBe(3)

      const state = yield* test.inspect(Counter, id)
      expect(state.events.map((e) => e.event)).toEqual([new CountChanged({ count: 3 })])
      expect(state.events[0]?.sequence).toBe(1)
      expect(state.timers.map((t) => t.key)).toEqual(["idle"])
      expect(state.receipts).toHaveLength(1)

      const [turn] = yield* test.turns.of(Counter, id)
      // discriminated on the command: `exit` is Exit<number, Overflow> here
      if (turn?.command === "Increment") expect(Exit.isSuccess(turn.exit) && turn.exit.value).toBe(3)
      expect(turn?.caller._tag).toBe("Anonymous")
    }))

  it.effect("a declared failure is a receipt too, and is replayed for the same commandId", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const counter = yield* Counter.get(CounterId.make("c2"))

      const first = yield* counter.Increment(5_000).pipe(Actor.commandId("k1"), Effect.exit)
      const again = yield* counter.Increment(5_000).pipe(Actor.commandId("k1"), Effect.exit)
      expect(first).toEqual(Exit.fail(new Overflow({ max: 1_000 })))
      expect(again).toEqual(first)

      const turns = yield* test.turns.of(Counter, CounterId.make("c2"))
      expect(turns.map((t) => t.replayed)).toEqual([false, true])

      // same commandId, different payload: the receipt does not match
      const conflict = yield* counter.Increment(1).pipe(Actor.commandId("k1"), Effect.flip)
      expect(conflict._tag).toBe("CommandConflict")
    }))

  it.effect("the idle timer fires after an hour of virtual time and is replaced, not duplicated", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = CounterId.make("c3")
      const counter = yield* Counter.get(id)

      yield* counter.Increment(1)
      yield* test.clock.advance("30 minutes")
      yield* counter.Increment(1) // re-arms `idle`: same key replaces the pending message
      expect((yield* test.inspect(Counter, id)).timers).toHaveLength(1)

      yield* test.clock.advance("59 minutes")
      expect((yield* test.turns.of(Counter, id)).map((t) => t.command)).toEqual(["Increment", "Increment"])

      yield* test.clock.advance("1 minute")
      const reset = yield* test.turns.next(Counter, id)
      expect(reset.command).toBe("Reset")
      expect(reset.trigger).toBe("timer")
      expect(reset.caller).toEqual({ _tag: "System", source: "timer", actor: reset.address })
      expect((yield* test.inspect(Counter, id)).timers).toEqual([])
    }))

  it.effect("committed-but-reply-lost is exactly once: redelivery replays the receipt", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = CounterId.make("c4")
      const counter = yield* Counter.get(id)

      yield* test.faults.crash(Counter, id, { at: "after-commit", command: "Increment" })
      const n = yield* counter.Increment(2).pipe(Actor.as(principal))
      expect(n).toBe(2)

      const turns = yield* test.turns.of(Counter, id)
      expect(turns.map((t) => [t.trigger, t.replayed])).toEqual([["call", false], ["redelivery", true]])
      // one event, one timer, one receipt: nothing was applied twice
      const state = yield* test.inspect(Counter, id)
      expect(state.events).toHaveLength(1)
      expect(state.receipts).toHaveLength(1)
    }))

  it.effect("a crash before commit persists nothing and the redelivered turn runs the handler once", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = CounterId.make("c5")
      const counter = yield* Counter.get(id)

      yield* test.faults.crash(Counter, id, { at: "before-commit" })
      yield* counter.Increment(1)
      const turns = yield* test.turns.of(Counter, id)
      expect(turns.map((t) => [t.trigger, t.exit._tag])).toEqual([["call", "Failure"], ["redelivery", "Success"]])
      expect((yield* test.inspect(Counter, id)).events).toHaveLength(1)
    }))

  it.effect("a stale generation is a defect, never a double apply", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = CounterId.make("c6")
      const counter = yield* Counter.get(id)
      yield* counter.Increment(1)

      yield* test.faults.staleGeneration(Counter, id)
      yield* counter.Increment(1)
      const state = yield* test.inspect(Counter, id)
      expect(state.generation).toBe(3) // 1 initial, +1 injected, +1 from the restart that took the fence
      expect(state.events).toHaveLength(2)
    }))

  it.effect("queries run without the entity: hibernated actor, no activation, same rows", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = CounterId.make("c7")
      const counter = yield* Counter.get(id)
      yield* counter.Increment(1)
      yield* test.clock.advance("31 seconds") // Hibernate.after("30 seconds")
      expect((yield* test.inspect(Counter, id)).resident).toBe(false)
      yield* counter.GetCount()
      expect((yield* test.inspect(Counter, id)).resident).toBe(false)
    }))

  const model: Model<typeof Counter, number> = {
    initial: 0,
    step: (count, step) => step.command === "Increment" ? count + step.input : 0,
    observe: () => Effect.succeed(0) // would read the counters row: `state.rows(counters)`
  }

  it.effect.prop(
    "under concurrent callers, duplicate commandIds and random crashes, the state equals the sequential model",
    { script: Scripts.arbitrary(Counter, { steps: { min: 1, max: 40 }, duplicateCommandIds: 0.2 }) },
    ({ script }) =>
      Effect.gen(function*() {
        const test = yield* ActorTest
        const id = CounterId.make("prop")
        yield* test.reset
        yield* test.faults.chaos({ probability: 0.1, at: ["before-commit", "after-commit"] })
        yield* test.check(Counter, id, model, script, { concurrency: 4 })
        const state = yield* test.inspect(Counter, id)
        // the cursor is what clients resume on: it must be gap-free
        expect(state.events.map((e) => e.sequence)).toEqual(state.events.map((_, i) => i + 1))
      }).pipe(Effect.scoped)
  )
})
