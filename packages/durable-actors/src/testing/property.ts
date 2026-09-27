import { Config, Effect, Predicate, Random } from "effect"
import { Arbitrary } from "effect/unstable/arbitrary"

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
  readonly runs?: number
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
