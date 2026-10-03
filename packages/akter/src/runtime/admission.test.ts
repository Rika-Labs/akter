import { describe, expect, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Exit, Fiber, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { ActorError } from "../errors/actor.ts"
import { admissionLimit, isOverloaded, overloaded } from "./admission.ts"

const WAIT = Duration.millis(100)

/** Admits an effect that records its start and then holds its slot until `release` completes. */
const holder = (
  admission: ReturnType<typeof admissionLimit>,
  started: Array<string>,
  label: string,
) =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>()
    const fiber = yield* admission
      .admit(Effect.sync(() => started.push(label)).pipe(Effect.andThen(Deferred.await(release))))
      .pipe(Effect.forkChild)

    return { fiber, release: Deferred.succeed(release, undefined) }
  })

const refusal = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.findErrorOption(exit).pipe(Option.filter(Schema.is(ActorError)), Option.map(isOverloaded))

describe("admissionLimit", () => {
  it.effect("preserves a pre-turn overload refusal through runner serialization", () =>
    Effect.gen(function* () {
      const codec = Schema.toCodecJson(ActorError)
      const encoded = yield* Schema.encodeEffect(codec)(overloaded("activation"))
      const decoded = yield* Schema.decodeEffect(codec)(encoded)

      expect(isOverloaded(decoded)).toBe(true)
      expect(decoded.reason).toMatchObject({ overloaded: true })
    }),
  )
  it.effect("hands a freed slot to the oldest waiter before any newcomer", () =>
    Effect.gen(function* () {
      const admission = admissionLimit({ limit: 1, wait: WAIT })
      const started: Array<string> = []
      const first = yield* holder(admission, started, "first")
      const second = yield* holder(admission, started, "second")
      yield* TestClock.adjust(0)
      expect(started).toEqual(["first"])

      yield* first.release
      const third = yield* holder(admission, started, "third")
      yield* TestClock.adjust(0)
      expect(started).toEqual(["first", "second"])

      yield* second.release
      yield* TestClock.adjust(0)
      expect(started).toEqual(["first", "second", "third"])
      yield* third.release
      expect(Exit.isSuccess(yield* Fiber.await(third.fiber))).toBe(true)
    }),
  )

  it.effect("refuses at once, without running, a caller past `limit` waiters", () =>
    Effect.gen(function* () {
      const admission = admissionLimit({ limit: 2, wait: WAIT })
      const started: Array<string> = []
      yield* holder(admission, started, "a")
      yield* holder(admission, started, "b")
      yield* holder(admission, started, "c")
      yield* holder(admission, started, "d")
      yield* TestClock.adjust(0)
      expect(admission.full()).toBe(true)

      const refused = yield* holder(admission, started, "e")
      yield* TestClock.adjust(0)
      const exit = yield* Fiber.await(refused.fiber)

      expect(refusal(exit)).toEqual(Option.some(true))
      expect(started).toEqual(["a", "b"])
    }),
  )

  it.effect("refuses a waiter whose wait runs out, never runs it, and keeps every slot", () =>
    Effect.gen(function* () {
      const admission = admissionLimit({ limit: 1, wait: WAIT })
      const started: Array<string> = []
      const first = yield* holder(admission, started, "first")
      const waiting = yield* holder(admission, started, "waiting")
      yield* TestClock.adjust(Duration.millis(99))
      expect(waiting.fiber.pollUnsafe()).toBeUndefined()

      yield* TestClock.adjust(Duration.millis(1))
      expect(refusal(yield* Fiber.await(waiting.fiber))).toEqual(Option.some(true))
      expect(admission.full()).toBe(false)

      yield* first.release
      yield* Fiber.await(first.fiber)
      const next = yield* holder(admission, started, "next")
      yield* TestClock.adjust(0)
      expect(started).toEqual(["first", "next"])
      yield* next.release
    }),
  )

  it.effect("passes the slot of an interrupted or failed holder to the next waiter", () =>
    Effect.gen(function* () {
      const admission = admissionLimit({ limit: 1, wait: WAIT })
      const started: Array<string> = []
      const failing = yield* admission.admit(Effect.fail("boom")).pipe(Effect.exit)
      expect(Exit.isFailure(failing)).toBe(true)

      const held = yield* holder(admission, started, "held")
      const waiting = yield* holder(admission, started, "waiting")
      yield* TestClock.adjust(0)
      yield* Fiber.interrupt(held.fiber)
      yield* TestClock.adjust(0)
      expect(started).toEqual(["held", "waiting"])
      yield* waiting.release
      expect(Exit.isSuccess(yield* Fiber.await(waiting.fiber))).toBe(true)
    }),
  )

  it.effect("a zero-wait gate refuses excess work without scheduling it", () =>
    Effect.gen(function* () {
      const admission = admissionLimit({ limit: 1, wait: Duration.zero })
      const started: Array<string> = []
      const held = yield* holder(admission, started, "held")
      yield* TestClock.adjust(0)
      const excess = yield* holder(admission, started, "excess")
      expect(refusal(yield* Fiber.await(excess.fiber))).toEqual(Option.some(true))
      expect(started).toEqual(["held"])
      yield* held.release
      yield* Fiber.await(held.fiber)
    }),
  )

  it.effect(
    "cancelling a queued waiter frees queue capacity without stealing the holder's slot",
    () =>
      Effect.gen(function* () {
        const admission = admissionLimit({ limit: 1, wait: WAIT })
        const started: Array<string> = []
        const held = yield* holder(admission, started, "held")
        const cancelled = yield* holder(admission, started, "cancelled")
        yield* TestClock.adjust(0)
        yield* Fiber.interrupt(cancelled.fiber)
        const next = yield* holder(admission, started, "next")
        yield* TestClock.adjust(0)
        expect(started).toEqual(["held"])
        yield* held.release
        yield* Fiber.await(held.fiber)
        yield* TestClock.adjust(0)
        expect(started).toEqual(["held", "next"])
        yield* next.release
      }),
  )
})
