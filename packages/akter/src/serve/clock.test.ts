import { Effect, Result } from "effect"
import { afterEach, expect, it, vi } from "vitest"
import { sampledDatabaseClock } from "./clock.ts"
import { ActorError, ActorUnavailable } from "../errors/actor.ts"

afterEach(() => vi.restoreAllMocks())

it("replaces a lower-RTT sample before serving time after the monotonic clock falls behind or jumps ahead", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let monotonic = 1_000
        let wall = 2_000_000
        let database = 7_000_000
        let reads = 0
        vi.spyOn(performance, "now").mockImplementation(() => monotonic)
        vi.spyOn(Date, "now").mockImplementation(() => wall)
        const clock = yield* sampledDatabaseClock(
          Effect.sync(() => {
            reads++
            return database
          }),
        )
        const now = clock.now
        expect(yield* now).toBe(database)
        for (const jump of [-304_000, 155_000]) {
          monotonic += 10 + jump
          wall += 10
          database += 10
          expect(yield* now).toBe(database)
        }
        const afterResume = reads
        for (let index = 0; index < 20; index++) {
          monotonic += 7
          wall += 7
          database += 7
          expect(yield* now).toBe(database)
        }
        expect(reads).toBe(afterResume)
      }),
    ),
  ))

it("discards a sample that spans suspension and resamples again instead of installing its offset", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let monotonic = 100
        let wall = 2_000_000
        let database = 7_000_000
        let reads = 0
        vi.spyOn(performance, "now").mockImplementation(() => monotonic)
        vi.spyOn(Date, "now").mockImplementation(() => wall)
        const clock = yield* sampledDatabaseClock(
          Effect.sync(() => {
            reads++
            if (reads === 2) {
              wall += 330_000
              database += 330_000
            }
            return database
          }),
        )
        monotonic += 155_000
        const failed = yield* Effect.result(clock.now)
        expect(Result.isFailure(failed)).toBe(true)
        expect(yield* clock.now).toBe(database)
        expect(reads).toBe(3)
      }),
    ),
  ))

it("resamples at the one-minute age boundary even when both local clocks advance together", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let monotonic = 100
        let wall = 2_000_000
        let database = 7_000_000
        let reads = 0
        vi.spyOn(performance, "now").mockImplementation(() => monotonic)
        vi.spyOn(Date, "now").mockImplementation(() => wall)
        const clock = yield* sampledDatabaseClock(
          Effect.sync(() => {
            reads++
            return database
          }),
        )
        monotonic += 59_999
        wall += 59_999
        database += 59_999
        expect(yield* clock.now).toBe(database)
        expect(reads).toBe(1)
        monotonic++
        wall++
        database++
        expect(yield* clock.now).toBe(database)
        expect(reads).toBe(2)
      }),
    ),
  ))

it("shares one resume resample across concurrent reads even when it is slower than the old sample", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let monotonic = 100
        let wall = 2_000_000
        let database = 7_000_000
        let reads = 0
        vi.spyOn(performance, "now").mockImplementation(() => monotonic)
        vi.spyOn(Date, "now").mockImplementation(() => wall)
        const clock = yield* sampledDatabaseClock(
          Effect.gen(function* () {
            reads++
            yield* Effect.sleep("10 millis")
            monotonic += reads === 1 ? 2 : 18
            wall += reads === 1 ? 2 : 18
            database += reads === 1 ? 2 : 18
            return database
          }),
        )
        wall += 330_000
        database += 330_000
        const resumed = yield* Effect.all(
          Array.from({ length: 16 }, () => clock.now),
          {
            concurrency: "unbounded",
          },
        )
        expect(reads).toBe(2)
        for (const value of resumed) expect(Math.abs(value - database)).toBeLessThanOrEqual(18)
      }),
    ),
  ))

it("fails closed when the database resample fails instead of returning the pre-suspend offset", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let monotonic = 100
        let available = true
        vi.spyOn(performance, "now").mockImplementation(() => monotonic)
        vi.spyOn(Date, "now").mockReturnValue(2_000_000)
        const clock = yield* sampledDatabaseClock(
          Effect.suspend(() =>
            available
              ? Effect.succeed(7_000_000)
              : Effect.fail(
                  ActorError.make({
                    reason: ActorUnavailable.make({ cause: new Error("offline") }),
                  }),
                ),
          ),
        )
        monotonic += 155_000
        available = false
        const failed = yield* Effect.result(clock.now)
        expect(Result.isFailure(failed)).toBe(true)
        available = true
        expect(yield* clock.now).toBe(7_000_000)
      }),
    ),
  ))
