import { describe, expect, it } from "vitest"
import { conformanceGroups, type ConformanceGroup } from "../../conformance.ts"
import { groupsOf, shards, UNSHARDED, unshardedGroups } from "./shards.ts"

const workers = [...Object.keys(shards), UNSHARDED]

describe("Postgres conformance shards", () => {
  it("runs every group in exactly one worker", () => {
    const named = workers.flatMap((worker) => groupsOf(worker))
    expect(new Set(named).size).toBe(named.length)
    expect([...named].sort()).toEqual(Object.keys(conformanceGroups).sort())
    expect(unshardedGroups.length > 0).toBe(true)
  })

  it("keeps every group with a replica case in one worker", () => {
    const replicaWorkers = workers.filter((worker) =>
      groupsOf(worker).some((group: ConformanceGroup) =>
        conformanceGroups[group].cases.some((conformanceCase) => conformanceCase.requiresReplica),
      ),
    )

    expect(replicaWorkers).toEqual(["replica"])
  })

  it("refuses a shard name the registry does not define", () => {
    expect(() => groupsOf("no-such-shard")).toThrow("Unknown conformance shard no-such-shard")
  })
})
