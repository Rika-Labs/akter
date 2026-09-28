import { isDeepStrictEqual } from "node:util"
import { Config, Effect, Predicate, Random, Result, Schema } from "effect"
import { Arbitrary } from "effect/unstable/arbitrary"
import type { AnyReducer } from "../members/reducer.ts"

/** The seed every property runs under unless `PROPERTY_SEED` overrides it. */
export const PROPERTY_SEED = "56"

/** Generated cases per property unless `PROPERTY_RUNS` overrides it. */
export const PROPERTY_RUNS = 1_000

/**
 * The seed for this run: `PROPERTY_SEED`, or a fresh one when it is `random`.
 * Rerunning with the printed seed regenerates the same inputs.
 */
const propertySeed = Effect.gen(function* () {
  const configured = yield* Config.String("PROPERTY_SEED").pipe(Config.withDefault(PROPERTY_SEED))

  if (configured !== "random") return configured

  return String(yield* Random.nextIntBetween(0, 2 ** 31 - 1))
}).pipe(Effect.orDie)

const propertyRuns = Config.Int("PROPERTY_RUNS").pipe(
  Config.withDefault(PROPERTY_RUNS),
  Effect.orDie,
)

/**
 * Checks `options.property` against `options.arbitrary` for a bounded, seeded number of runs
 * and dies with the seed and the shrunk counterexample if it fails, so a
 * failure reproduces with `PROPERTY_SEED=<seed>`. Returns the executed runs.
 */
export const checkProperty = <A, E = never, R = never>(options: {
  readonly name: string
  readonly arbitrary: Arbitrary.Arbitrary<A>
  readonly property: (value: A) => boolean | Effect.Effect<boolean, E, R>
  readonly runs?: number | undefined
}): Effect.Effect<number, never, R> =>
  Effect.gen(function* () {
    const seed = yield* propertySeed
    const runs = options.runs ?? (yield* propertyRuns)

    const result = yield* Arbitrary.checkEffect(options.arbitrary, options.property, {
      seed,
      runs,
    })

    if (Predicate.isTagged(result, "Passed") && result.runs === runs) return result.runs

    return yield* Effect.die(
      new Error(
        `Property "${options.name}" failed with PROPERTY_SEED=${seed}\n${Arbitrary.formatCheckFailure(result) ?? result._tag}`,
      ),
    )
  })

/** What one `reduce` produced: the new state, or the defect it threw. */
type Reduced =
  | { readonly ok: true; readonly state: Parameters<AnyReducer["reduce"]>[0] }
  | { readonly ok: false }

type ReducerState = Parameters<AnyReducer["reduce"]>[0]

type ReducerInput = Parameters<AnyReducer["reduce"]>[1]

const reduceSafely = (reducer: AnyReducer, state: ReducerState, input: ReducerInput): Reduced => {
  try {
    const reduced = reducer.reduce(state, input)

    return Result.isSuccess(reduced) ? { ok: true, state: reduced.success } : { ok: false }
  } catch {
    return { ok: false }
  }
}

/**
 * Checks a commutative reducer's merge law over generated states and input
 * lists: reducing the inputs one at a time, in order, must equal reducing
 * their combination once. The runtime merges only calls that satisfy it, so
 * run this for every commutative reducer. States and inputs default to their
 * schemas' arbitraries; lists hold 1 to `maxInputs` inputs (default 8).
 * Returns the executed runs, and dies with a reproducible seed on failure.
 */
export const checkMergeLaw = (options: {
  readonly reducer: AnyReducer
  readonly state?: Arbitrary.Arbitrary<ReducerState>
  readonly input?: Arbitrary.Arbitrary<ReducerInput>
  readonly maxInputs?: number
  readonly runs?: number
}): Effect.Effect<number> => {
  const { reducer } = options
  const commutative = reducer.commutative

  if (commutative === undefined)
    return Effect.die(new Error(`Reducer ${reducer.tag} is not commutative`))

  const state = options.state ?? Arbitrary.schema(Schema.Struct(reducer.state.fields))
  const input = options.input ?? Arbitrary.schema(reducer.input)

  return checkProperty({
    name: `merge law of ${reducer.tag}`,
    runs: options.runs,
    arbitrary: Arbitrary.all([
      state,
      Arbitrary.array(input, { minLength: 1, maxLength: options.maxInputs ?? 8 }),
    ]),
    property: ([initial, inputs]) => {
      let sequential: Reduced = { ok: true, state: initial }

      for (const next of inputs)
        if (sequential.ok) sequential = reduceSafely(reducer, sequential.state, next)

      const combined = inputs.reduce((first, second) => commutative.combine(first, second))
      const merged = reduceSafely(reducer, initial, combined)

      return isDeepStrictEqual(sequential, merged)
    },
  })
}
