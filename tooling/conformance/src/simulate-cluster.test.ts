import { ConfigProvider, Effect } from "effect"
import { describe, expect, it } from "vitest"
import { clusterSimulationSeeds, failoverSimulationSeeds } from "./simulate-cluster.ts"

const withEnv = <A>(env: Record<string, string>, effect: Effect.Effect<A>) =>
  effect.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })))

describe("cluster simulation seeds", () => {
  it("run the pull request seeds from 0 by default", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* withEnv({}, clusterSimulationSeeds)).toEqual(["0", "1"])
        expect(yield* withEnv({}, failoverSimulationSeeds)).toEqual(["0"])
      }),
    ))

  it("count up from the base a rerun names", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* withEnv(
            { SIMULATION_SEED_BASE: "40", CLUSTER_SIMULATION_SEEDS: "3" },
            clusterSimulationSeeds,
          ),
        ).toEqual(["40", "41", "42"])

        expect(
          yield* withEnv(
            { SIMULATION_SEED_BASE: "7", PROPERTY_SEED: "random", FAILOVER_SIMULATION_SEEDS: "2" },
            failoverSimulationSeeds,
          ),
        ).toEqual(["7", "8"])
      }),
    ))

  it("cover more seeds from a drawn base on the nightly run", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const nightly = { PROPERTY_SEED: "random" }
        const cluster = (yield* withEnv(nightly, clusterSimulationSeeds)).map(Number)
        const failover = (yield* withEnv(nightly, failoverSimulationSeeds)).map(Number)

        expect(cluster).toEqual(Array.from({ length: 6 }, (_, index) => cluster[0]! + index))
        expect(failover).toEqual(Array.from({ length: 3 }, (_, index) => failover[0]! + index))
        expect(cluster[0]).toBeGreaterThanOrEqual(0)
      }),
    ))
})
