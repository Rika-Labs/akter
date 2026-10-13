import { describe, expect, it } from "@effect/vitest"
import { Clock, Deferred, Duration, Effect, Exit, Scope } from "effect"
import { TestClock } from "effect/testing"
import { TimerWheels } from "./timer-wheel.ts"

const settled = Effect.repeat(Effect.yieldNow, { times: 20 })

/** Observes real TestClock sleeps, including their interruption, without replacing clock behavior. */
const observedClock = Effect.gen(function* () {
  const base = yield* Clock.clockWith(Effect.succeed)
  const delays: Array<number> = []
  let active = 0
  let peak = 0
  const clock: Clock.Clock = {
    currentTimeMillis: base.currentTimeMillis,
    currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
    currentTimeNanos: base.currentTimeNanos,
    currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    sleep: (duration) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          active += 1
          peak = Math.max(peak, active)
          delays.push(Duration.toMillis(duration))
        }),
        () => base.sleep(duration),
        () =>
          Effect.sync(() => {
            active -= 1
          }),
      ),
  }
  return { clock, delays, active: () => active, peak: () => peak }
})

describe("scoped timer wheel", () => {
  it.effect("orders due times, replaces pending ids and cancels without firing early", () =>
    Effect.gen(function* () {
      const wheel = yield* TimerWheels.make
      const fired: Array<string> = []
      const record = (id: string) =>
        Effect.sync(() => {
          fired.push(id)
        })
      yield* wheel.schedule("late", 300, record("superseded"))
      yield* wheel.schedule("middle", 200, record("cancelled"))
      yield* wheel.schedule("first", 100, record("first"))
      yield* TestClock.adjust(99)
      expect(fired).toEqual([])
      yield* TestClock.adjust(1)
      yield* settled
      expect(fired).toEqual(["first"])
      yield* wheel.cancel("middle")
      yield* wheel.cancel("absent")
      yield* wheel.schedule("late", 250, record("replacement"))
      yield* TestClock.adjust(149)
      expect(fired).toEqual(["first"])
      yield* TestClock.adjust(1)
      yield* settled
      expect(fired).toEqual(["first", "replacement"])
      yield* TestClock.adjust(100)
      expect(fired).toEqual(["first", "replacement"])
    }),
  )

  it.effect(
    "wakes an empty or sleeping queue when an earlier timer arrives or its head moves",
    () =>
      Effect.gen(function* () {
        const wheel = yield* TimerWheels.make
        const fired: Array<string> = []
        const record = (id: string) =>
          Effect.sync(() => {
            fired.push(id)
          })
        yield* settled
        yield* wheel.schedule("later", 900, record("later"))
        yield* settled
        yield* wheel.schedule("earlier", 100, record("earlier"))
        yield* TestClock.adjust(100)
        yield* settled
        expect(fired).toEqual(["earlier"])
        yield* wheel.schedule("later", 1_200, record("moved"))
        yield* settled
        yield* TestClock.adjust(800)
        expect(fired).toEqual(["earlier"])
        yield* TestClock.adjust(300)
        yield* settled
        expect(fired).toEqual(["earlier", "moved"])
        yield* wheel.schedule("overdue", 5, record("overdue"))
        yield* settled
        expect(fired).toEqual(["earlier", "moved", "overdue"])
      }),
  )

  it.effect(
    "keeps one sleep for thousands of heap entries and removes arbitrary cancelled entries",
    () =>
      Effect.gen(function* () {
        const observed = yield* observedClock
        const wheel = yield* TimerWheels.make.pipe(
          Effect.provideService(Clock.Clock, observed.clock),
        )
        const fired: Array<number> = []
        const expected: Array<number> = []
        for (let index = 0; index < 4_096; index++) {
          const at = 100 + ((index * 7_919) % 4_096)
          yield* wheel.schedule(
            String(index),
            at,
            Effect.sync(() => {
              fired.push(at)
            }),
          )
          if (index % 3 !== 0) expected.push(at)
        }
        yield* settled
        expect(observed.active()).toBe(1)
        for (let index = 0; index < 4_096; index += 3) yield* wheel.cancel(String(index))
        yield* settled
        expect(observed.active()).toBe(1)
        expect(observed.peak()).toBe(1)
        yield* TestClock.adjust(4_196)
        yield* settled
        expect(fired).toEqual(expected.sort((left, right) => left - right))
        expect(observed.active()).toBe(0)
        expect(observed.peak()).toBe(1)
      }),
  )

  it.effect("bounds a distant sleep without overflowing the host timer or firing early", () =>
    Effect.gen(function* () {
      const observed = yield* observedClock
      const wheel = yield* TimerWheels.make.pipe(Effect.provideService(Clock.Clock, observed.clock))
      let fired = false
      const at = 2_147_483_647 + 123
      yield* wheel.schedule(
        "distant",
        at,
        Effect.sync(() => {
          fired = true
        }),
      )
      yield* settled
      expect(observed.delays).toEqual([2_147_483_647])
      yield* TestClock.adjust(2_147_483_647)
      yield* settled
      expect(fired).toBe(false)
      expect(observed.delays).toEqual([2_147_483_647, 123])
      yield* TestClock.adjust(122)
      expect(fired).toBe(false)
      yield* TestClock.adjust(1)
      yield* settled
      expect(fired).toBe(true)
    }),
  )

  it.effect(
    "does not serialize due effects and closes the sleeper, pending work and running effects",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const observed = yield* observedClock
        const wheel = yield* TimerWheels.make.pipe(
          Scope.provide(scope),
          Effect.provideService(Clock.Clock, observed.clock),
        )
        const started = yield* Deferred.make<void>()
        let interrupted = false
        const fired: Array<string> = []
        yield* wheel.schedule(
          "blocked",
          0,
          Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                interrupted = true
              }),
            ),
          ),
        )
        yield* Deferred.await(started)
        yield* wheel.schedule(
          "unblocked",
          10,
          Effect.sync(() => {
            fired.push("unblocked")
          }),
        )
        yield* wheel.schedule(
          "pending",
          20,
          Effect.sync(() => {
            fired.push("pending")
          }),
        )
        yield* TestClock.adjust(10)
        yield* settled
        expect(fired).toEqual(["unblocked"])
        expect(observed.active()).toBe(1)
        yield* Scope.close(scope, Exit.void)
        expect(interrupted).toBe(true)
        expect(observed.active()).toBe(0)
        yield* wheel.schedule(
          "closed",
          0,
          Effect.sync(() => {
            fired.push("closed")
          }),
        )
        yield* wheel.cancel("pending")
        yield* TestClock.adjust(20)
        expect(fired).toEqual(["unblocked"])
      }),
  )
})
