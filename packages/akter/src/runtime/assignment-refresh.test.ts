import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { assignmentRefresh } from "./assignment-refresh.ts"

const settled = Effect.repeat(Effect.yieldNow, { times: 20 })

describe("assignment refresh wake", () => {
  it.effect("rejects losing a release wake before the next membership wait starts", () =>
    Effect.gen(function* () {
      const refresh = assignmentRefresh("4 seconds")
      yield* refresh.wait
      yield* refresh.wake
      yield* refresh.wake
      const notified = yield* Effect.forkChild(refresh.wait)
      yield* settled
      expect(notified.pollUnsafe()).toBeDefined()
      const periodic = yield* Effect.forkChild(refresh.wait)
      yield* TestClock.adjust(3999)
      expect(periodic.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      yield* Fiber.join(periodic)
    }),
  )

  it.effect("rejects waiting for the periodic tick when a release arrives during a wait", () =>
    Effect.gen(function* () {
      const refresh = assignmentRefresh("4 seconds")
      yield* refresh.wait
      const waiting = yield* Effect.forkChild(refresh.wait)
      yield* TestClock.adjust(73)
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* refresh.wake
      yield* settled
      expect(waiting.pollUnsafe()).toBeDefined()
    }),
  )

  it.effect("rejects restarting the periodic deadline after an interrupted membership read", () =>
    Effect.gen(function* () {
      const refresh = assignmentRefresh("15 seconds")
      yield* refresh.wait
      const interrupted = yield* Effect.forkChild(refresh.wait)
      yield* TestClock.adjust(5000)
      yield* Fiber.interrupt(interrupted)
      const resumed = yield* Effect.forkChild(refresh.wait)
      yield* TestClock.adjust(9999)
      expect(resumed.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      yield* Fiber.join(resumed)
    }),
  )
})
