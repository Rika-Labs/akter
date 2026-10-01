import { Effect, Exit, Result, Schema } from "effect"
import { Arbitrary } from "effect/unstable/arbitrary"
import { describe, expect, it } from "@effect/vitest"
import { Actor } from "../index.ts"
import { Bump, Fragile } from "./conformance/batches.ts"
import { Tick as MultiRunnerTick } from "./conformance/multi-runner.ts"
import { checkBatchLaw } from "./property.ts"

const Counted = Actor.state({
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

const Logged = Actor.state({
  log: Schema.mutable(Schema.Array(Schema.Int)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
})

const Sum = Actor.reducer("Sum", {
  state: Counted,
  payload: Schema.Int,
  reduce: (state, amount) => Result.succeed({ count: state.count + amount }),
  batch: { combine: (first, second) => first + second },
})

/** Every reduction fails, so sequential and folded paths fail alike. */
const AlwaysThrows = Actor.reducer("AlwaysThrows", {
  state: Counted,
  payload: Schema.Int,
  reduce: () => {
    throw new Error("reducer bug")
  },
  batch: { combine: (first, second) => first + second },
})

/** Returns the same count on both paths, one the Int state schema rejects. */
const Invalid = Actor.reducer("Invalid", {
  state: Counted,
  payload: Schema.Int,
  reduce: () => Result.succeed({ count: 0.5 }),
  batch: { combine: (first, second) => first + second },
})

/** Appends in place: ordered and noncommutative, and it mutates the state it receives. */
const Append = Actor.reducer("Append", {
  state: Logged,
  payload: Schema.mutable(Schema.Array(Schema.Int)),
  reduce: (state, items) => {
    state.log.push(...items)

    return Result.succeed(state)
  },
  batch: { combine: (first, second) => [...first, ...second] },
})

/** Appends correctly but combines in reverse order, so a fold of two or more distinct inputs differs. */
const Reversed = Actor.reducer("Reversed", {
  state: Logged,
  payload: Schema.mutable(Schema.Array(Schema.Int)),
  reduce: (state, items) => Result.succeed({ log: [...state.log, ...items] }),
  batch: { combine: (first, second) => [...second, ...first] },
})

/**
 * Appends in place and combines in reverse. A checker that hands both paths the
 * same state object sees one array and calls them equal.
 */
const ReversedInPlace = Actor.reducer("ReversedInPlace", {
  state: Logged,
  payload: Schema.mutable(Schema.Array(Schema.Int)),
  reduce: (state, items) => {
    state.log.push(...items)

    return Result.succeed(state)
  },
  batch: { combine: (first, second) => [...second, ...first] },
})

const bounded = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 })),
)

const small = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })))

const items = Arbitrary.array(small, { minLength: 1, maxLength: 3 })

const fails = (effect: Effect.Effect<number>) => Effect.map(Effect.exit(effect), Exit.isFailure)

describe("checkBatchLaw", () => {
  it.effect("accepts the fixtures' batch reducers over generated states and inputs", () =>
    Effect.gen(function* () {
      for (const { reducer, state } of [
        { reducer: Sum, state: (count: number) => ({ count }) },
        { reducer: Bump, state: (count: number) => ({ count, log: [] }) },
        { reducer: MultiRunnerTick, state: (count: number) => ({ count }) },
      ])
        expect(
          yield* checkBatchLaw({
            reducer,
            state: Arbitrary.map(bounded, state),
            input: bounded,
            maxInputs: 16,
            runs: 200,
          }),
        ).toBe(200)
    }),
  )

  it.effect("accepts an order-sensitive append whose reduce mutates its state in place", () =>
    Effect.gen(function* () {
      expect(
        yield* checkBatchLaw({
          reducer: Append,
          state: Arbitrary.map(items, (log) => ({ log })),
          input: items,
          runs: 200,
        }),
      ).toBe(200)
    }),
  )

  it.effect("rejects a reducer that always throws, though both paths fail equally", () =>
    Effect.gen(function* () {
      expect(yield* fails(checkBatchLaw({ reducer: AlwaysThrows, input: small, runs: 3 }))).toBe(
        true,
      )
    }),
  )

  it.effect("rejects a reducer whose equal results violate the state schema", () =>
    Effect.gen(function* () {
      expect(yield* fails(checkBatchLaw({ reducer: Invalid, input: small, runs: 20 }))).toBe(true)
    }),
  )

  it.effect("rejects a fold that throws only for the combined input", () =>
    Effect.gen(function* () {
      expect(
        yield* fails(
          checkBatchLaw({
            reducer: Fragile,
            state: Arbitrary.map(bounded, (count) => ({ count, log: [] })),
            input: small,
          }),
        ),
      ).toBe(true)
    }),
  )

  it.effect("rejects a combine that reverses the order of the inputs", () =>
    Effect.gen(function* () {
      expect(
        yield* fails(
          checkBatchLaw({
            reducer: Reversed,
            state: Arbitrary.map(items, (log) => ({ log })),
            input: items,
            maxInputs: 4,
            runs: 200,
          }),
        ),
      ).toBe(true)
    }),
  )

  it.effect(
    "rejects a reversed in-place append even though both paths share one state object",
    () =>
      Effect.gen(function* () {
        expect(
          yield* fails(
            checkBatchLaw({
              reducer: ReversedInPlace,
              state: Arbitrary.map(items, (log) => ({ log })),
              input: items,
              maxInputs: 4,
              runs: 200,
            }),
          ),
        ).toBe(true)
      }),
  )

  it.effect("refuses a reducer without batch folding", () =>
    Effect.gen(function* () {
      const Plain = Actor.reducer("Plain", {
        state: Counted,
        payload: Schema.Int,
        reduce: (state, amount) => Result.succeed({ count: state.count + amount }),
      })

      expect(yield* fails(checkBatchLaw({ reducer: Plain }))).toBe(true)
    }),
  )
})
