import { layerClientProtocol, layerSocketServer } from "@effect/platform-bun/BunClusterSocket"
import { Effect, HashRing, Layer, Option, PrimaryKey } from "effect"
import { RunnerAddress, RunnerStorage, ShardingConfig } from "effect/cluster"
import { Runner as ClusterRunner } from "effect/cluster/Runner"
import { describe, expect, it } from "vitest"
import { acquiredShards, Runner, RunnerWiring } from "./runner.ts"

const transport = Layer.merge(layerSocketServer, layerClientProtocol)
const address = { host: "runner-a.internal", port: 4400 }

describe("production runner configuration", () => {
  it("advertises a direct address independently of its bind address and defaults to 256 lease-locked shards", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          Runner.socket({ address, listenAddress: { host: "0.0.0.0", port: 5500 }, transport }),
        )
        const wiring = yield* RunnerWiring.pipe(Effect.provideContext(context))
        expect(wiring.production).toBe(true)
        expect(wiring.config.runnerAddress).toEqual(
          Option.some(RunnerAddress.RunnerAddress.make(address)),
        )
        expect(wiring.config.runnerListenAddress).toEqual(
          Option.some(RunnerAddress.RunnerAddress.make({ host: "0.0.0.0", port: 5500 })),
        )
        expect(wiring.config.shardsPerGroup).toBe(256)
        expect(wiring.config.shardLockDisableAdvisory).toBe(true)
      }).pipe(Effect.scoped),
    ))

  it("refuses invalid advertise addresses, counts, and lock durations before starting a listener", () => {
    for (const host of ["", " ", "0.0.0.0", "::", "*"])
      expect(() => Runner.socket({ address: { ...address, host }, transport })).toThrow(
        "Runner address",
      )
    for (const port of [0, 65536, 4.5])
      expect(() => Runner.socket({ address: { ...address, port }, transport })).toThrow(
        "Runner address",
      )
    for (const shardsPerGroup of [0, 1.5, 65537])
      expect(() => Runner.socket({ address, transport, shardsPerGroup })).toThrow("shardsPerGroup")
    expect(() => Runner.socket({ address, transport, shardLockExpiration: "2 seconds" })).toThrow(
      "shardLockExpiration",
    )
    expect(() =>
      Runner.socket({ address, transport, shardLockRefreshInterval: "0 millis" }),
    ).toThrow("shardLockRefreshInterval")
  })

  it("refuses an entity termination timeout that outlasts the lock expiration minus its effective refresh", () => {
    const socket =
      (options: Omit<Parameters<typeof Runner.socket>[0], "address" | "transport">) => () =>
        Runner.socket({ address, transport, ...options })
    expect(socket({ entityTerminationTimeout: "25 seconds" })).not.toThrow()
    expect(socket({ entityTerminationTimeout: "25001 millis" })).toThrow("entityTerminationTimeout")
    expect(
      socket({ shardLockRefreshInterval: "5 seconds", entityTerminationTimeout: "30 seconds" }),
    ).not.toThrow()
    expect(
      socket({ shardLockRefreshInterval: "5 seconds", entityTerminationTimeout: "30001 millis" }),
    ).toThrow("entityTerminationTimeout")
    expect(
      socket({ shardLockExpiration: "3 seconds", entityTerminationTimeout: "2 seconds" }),
    ).not.toThrow()
    expect(
      socket({ shardLockExpiration: "3 seconds", entityTerminationTimeout: "2001 millis" }),
    ).toThrow("entityTerminationTimeout")
    expect(socket({ shardLockExpiration: "3 seconds" })).toThrow("entityTerminationTimeout")
  })

  it("is unready until every currently assigned shard is acquired, including a runner's private holder group", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const self = RunnerAddress.RunnerAddress.make(address)
        const other = RunnerAddress.RunnerAddress.make({ host: "runner-b.internal", port: 4401 })
        const own = ClusterRunner.make({ address: self, groups: ["default", "holder"], weight: 1 })
        const peer = ClusterRunner.make({ address: other, groups: ["default"], weight: 1 })
        const storage = yield* RunnerStorage.makeMemory
        let runners: Array<readonly [ClusterRunner, boolean]> = []
        const readiness = yield* acquiredShards.pipe(
          Effect.provideService(RunnerStorage.RunnerStorage, {
            ...storage,
            getRunners: Effect.suspend(() => Effect.succeed(runners)),
          }),
          Effect.provideService(ShardingConfig.ShardingConfig, {
            ...ShardingConfig.defaults,
            runnerAddress: Option.some(self),
            shardsPerGroup: 32,
            assignedShardGroups: ["default", "holder"],
          }),
        )
        const held = new Set<string>()
        const sharding = {
          hasShardId: (shard: Parameters<typeof storage.release>[1]) =>
            held.has(`${shard.group}:${shard.id}`),
        }
        expect(yield* readiness.acquired(sharding)).toBe(false)
        runners = [
          [own, true],
          [peer, true],
        ]
        expect(yield* readiness.acquired(sharding)).toBe(false)
        const ring = HashRing.make<RunnerAddress.RunnerAddress>()
        HashRing.add(ring, self)
        HashRing.add(ring, other)
        for (const [index, owner] of HashRing.getShards(ring, 32)!.entries())
          if (PrimaryKey.value(owner) === PrimaryKey.value(self)) held.add(`default:${index + 1}`)
        expect(yield* readiness.acquired(sharding)).toBe(false)
        for (let index = 1; index <= 32; index++) held.add(`holder:${index}`)
        expect(yield* readiness.acquired(sharding)).toBe(true)
        held.delete("holder:17")
        expect(yield* readiness.acquired(sharding)).toBe(false)
        runners = [
          [own, false],
          [peer, true],
        ]
        expect(yield* readiness.acquired(sharding)).toBe(false)
      }).pipe(Effect.scoped),
    ))
})
