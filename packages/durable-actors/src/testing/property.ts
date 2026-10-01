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

type ReducerState = Parameters<AnyReducer["reduce"]>[0]

type ReducerInput = Parameters<AnyReducer["reduce"]>[1]

/** The combiner that lets the runtime fold consecutive queued calls into one turn. */
const batchOf = (reducer: AnyReducer) => reducer.batch

/**
 * Runs `reduce` on a private copy of `state`, as the runtime does, and
 * returns the next state only when it succeeded and satisfies the state
 * schema; a declared failure, a throw, or an invalid state is `undefined`.
 */
const reduceValid = (
  reducer: AnyReducer,
  valid: (state: ReducerState) => boolean,
  state: ReducerState,
  input: ReducerInput,
): ReducerState | undefined => {
  try {
    const reduced = reducer.reduce(structuredClone(state), input)

    return Result.isSuccess(reduced) && valid(reduced.success) ? reduced.success : undefined
  } catch {
    return undefined
  }
}

/**
 * Checks a batch reducer's ordered fold law over generated states and input
 * lists: reducing the inputs one at a time, in order, and reducing their
 * in-order combination once must both succeed with a valid state, and the two
 * states must be equal. The law is about order-preserving folding, not
 * commutativity, so an order-sensitive combine such as appending passes. A
 * reducer that fails or throws for either path fails the check, because the
 * runtime only folds calls whose reduction cannot fail. States and inputs
 * default to their schemas' arbitraries; lists hold 1 to `maxInputs` inputs
 * (default 8). Returns the executed runs, and dies with a reproducible seed on
 * failure.
 */
export const checkBatchLaw = (options: {
  readonly reducer: AnyReducer
  readonly state?: Arbitrary.Arbitrary<ReducerState>
  readonly input?: Arbitrary.Arbitrary<ReducerInput>
  readonly maxInputs?: number
  readonly runs?: number
}): Effect.Effect<number> => {
  const { reducer } = options
  const batch = batchOf(reducer)

  if (batch === undefined)
    return Effect.die(new Error(`Reducer ${reducer.tag} does not declare batch folding`))

  const stateSchema = Schema.Struct(reducer.state.fields)
  const valid = Schema.is(stateSchema)
  const state = options.state ?? Arbitrary.schema(stateSchema)
  const input = options.input ?? Arbitrary.schema(reducer.payload)

  return checkProperty({
    name: `batch law of ${reducer.tag}`,
    runs: options.runs,
    arbitrary: Arbitrary.all([
      state,
      Arbitrary.array(input, { minLength: 1, maxLength: options.maxInputs ?? 8 }),
    ]),
    property: ([initial, inputs]) => {
      let sequential: ReducerState | undefined = initial

      for (const next of inputs)
        if (sequential !== undefined) sequential = reduceValid(reducer, valid, sequential, next)

      let combined: ReducerInput

      try {
        combined = inputs.reduce((first, second) => batch.combine(first, second))
      } catch {
        return false
      }

      const folded = reduceValid(reducer, valid, initial, combined)

      return (
        sequential !== undefined && folded !== undefined && isDeepStrictEqual(sequential, folded)
      )
    },
  })
}
