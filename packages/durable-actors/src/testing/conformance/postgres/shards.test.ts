import { BunFileSystem } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { conformanceGroups } from "../../conformance.ts"
import { shards } from "./shards.ts"

const harness = ManagedRuntime.make(BunFileSystem.layer)

afterAll(() => harness.dispose())

describe("Postgres conformance shards", () => {
  it("gives every shard a file that runs exactly its groups", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        for (const shard of Object.keys(shards)) {
          const file = yield* fs.readFileString(
            new URL(`../${shard}.test.ts`, import.meta.url).pathname,
          )

          expect(file).toContain(`describePostgres(shards["${shard}"])`)
        }
      }),
    ))

  it("names each group in at most one shard, and only groups that exist", () => {
    const named = Object.values(shards).flat()
    expect(new Set(named).size).toBe(named.length)
    expect(named.filter((group) => !(group in conformanceGroups))).toEqual([])
  })
})
