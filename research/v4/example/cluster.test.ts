// Typecheck-only sketch: two runners in one process, one storage, real serialization. Rebalance must not double-apply.
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect, Fiber, Layer, Option } from "effect"
import { ActorTest } from "../framework/Testing.ts"
import { Counter, CounterId } from "./Counter.ts"
import { CounterLive } from "./Counter.server.ts"

const TestLive = CounterLive.pipe(Layer.provideMerge(ActorTest.layer({ runners: 2 })))

it.layer(TestLive)("cluster", (it) => {
  it.effect("killing the hosting runner moves the actor; the in-flight turn on the dead runner cannot commit", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = CounterId.make("c1")
      const counter = yield* Counter.get(id)
      yield* counter.Increment(1)

      const host = yield* test.cluster.runnerOf(Counter, id)
      expect(Option.isSome(host)).toBe(true)
      if (Option.isNone(host)) return

      // park the turn inside its transaction, then kill the runner hosting it
      const paused = yield* test.faults.pause(Counter, id, { at: "before-commit" })
      const inFlight = yield* counter.Increment(1).pipe(Effect.exit, Effect.forkScoped)
      yield* paused.reached
      yield* test.cluster.kill(host.value) // interrupts the parked fiber: its transaction rolls back

      // no takeover before the lease expires (shardLockExpiration is 35s)
      yield* test.clock.advance("20 seconds")
      expect((yield* test.inspect(Counter, id)).events).toHaveLength(1)

      yield* test.clock.advance("20 seconds")
      yield* test.settle

      const moved = yield* test.cluster.runnerOf(Counter, id)
      expect(Option.map(moved, (r) => r.index)).not.toEqual(Option.some(host.value.index))
      const turns = yield* test.turns.of(Counter, id)
      // first call, the interrupted attempt (never committed), then the survivor's re-read of the envelope
      expect(turns.map((t) => [t.trigger, t.exit._tag])).toEqual([["call", "Success"], ["call", "Failure"], ["redelivery", "Success"]])
      const state = yield* test.inspect(Counter, id)
      expect(state.events).toHaveLength(2)
      expect(state.generation).toBe(2)
      // the caller's fiber outlives the killed runner: it gets the survivor's reply, not an ActorUnavailable
      expect((yield* Fiber.join(inFlight))._tag).toBe("Success")
    }))

  it.effect("an isolated runner cannot fence: its turns fail on the generation row, not on the network", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = CounterId.make("c2")
      const counter = yield* Counter.get(id)
      yield* counter.Increment(1)
      const host = yield* test.cluster.runnerOf(Counter, id)
      if (Option.isNone(host)) return

      yield* test.cluster.isolate(host.value)
      yield* test.clock.advance("2 minutes")
      yield* counter.Increment(1)
      const turns = yield* test.turns.of(Counter, id)
      expect(turns.filter((t) => t.command === "Increment" && t.exit._tag === "Success")).toHaveLength(2)
    }).pipe(Effect.scoped))

  it.effect("every runner sees the same event feed", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = CounterId.make("c3")
      const counter = yield* Counter.get(id)
      yield* counter.Increment(1)
      yield* counter.Increment(1)
      const runners = yield* test.cluster.runners
      expect(runners).toHaveLength(2)
      expect((yield* test.inspect(Counter, id)).events.map((e) => e.sequence)).toEqual([1, 2])
    }))
})
