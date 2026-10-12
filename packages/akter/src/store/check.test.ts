import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { type Bucket, Condition } from "./bucket.ts"
import { checkBucket } from "./check.ts"
import { memoryBucket } from "./memory.ts"

/**
 * A bucket whose conditional writes check and then write as two steps, the
 * way a backend without atomic conditional writes behaves: concurrent writers
 * can all pass the check before any of them writes.
 */
const checkThenWrite = (bucket: Bucket): Bucket => ({
  ...bucket,
  create: (key, body) =>
    Effect.gen(function* () {
      if (Option.isSome(yield* bucket.head(key))) return false
      yield* Effect.yieldNow
      yield* bucket.put(key, body)
      return true
    }),
  leases: {
    ...bucket.leases,
    write: (key, body, condition) =>
      Condition.$match(condition, {
        Matches: ({ etag }) =>
          Effect.gen(function* () {
            const current = yield* bucket.leases.read(key)
            if (!Option.exists(current, (object) => object.etag === etag))
              return Option.none<string>()
            yield* Effect.yieldNow
            return yield* bucket.leases.write(key, body, Condition.Always())
          }),
        Absent: () => bucket.leases.write(key, body, condition),
        Always: () => bucket.leases.write(key, body, condition),
      }),
  },
})

/**
 * A bucket that skips a plain `PUT` whose bytes equal what the key already
 * holds, the way a deduplicating backend does: the object keeps its first
 * last-modified time, so nothing ever ages out of the grace period's reach.
 */
const skipsIdenticalPuts = (bucket: Bucket): Bucket => ({
  ...bucket,
  put: (key, body) =>
    Effect.gen(function* () {
      const current = yield* bucket.get(key)
      if (Option.exists(current, (bytes) => bytesEqual(bytes, body))) return
      yield* bucket.put(key, body)
    }),
})

const bytesEqual = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

describe("checkBucket", () => {
  it.live(
    "fails a bucket whose conditional create and compare-and-swap are not atomic, and passes the same bucket with atomic ones (rejects a probe that never races its writers)",
    () =>
      Effect.gen(function* () {
        const options = { writers: 8, rounds: 3, writes: 3, settle: "20 millis" } as const
        const racy = yield* checkBucket(checkThenWrite(memoryBucket()))(options)
        expect(racy.passed).toBe(false)
        expect(racy.probes.filter((probe) => !probe.passed).map((probe) => probe.name)).toEqual([
          "conditional create race",
          "compare-and-swap race",
        ])

        const atomic = yield* checkBucket(memoryBucket())(options)
        expect(atomic.probes.filter((probe) => !probe.passed)).toEqual([])
        expect(atomic.passed).toBe(true)
      }),
  )

  it.live(
    "fails a bucket whose plain PUT of identical bytes keeps the old last-modified time, and passes the same bucket when it refreshes it (rejects a probe that writes different bytes the second time or never waits between writes)",
    () =>
      Effect.gen(function* () {
        const options = { writers: 4, rounds: 2, writes: 2, settle: "20 millis" } as const
        const dedupes = yield* checkBucket(skipsIdenticalPuts(memoryBucket()))(options)
        expect(dedupes.passed).toBe(false)
        expect(dedupes.probes.filter((probe) => !probe.passed).map((probe) => probe.name)).toEqual([
          "overwrite refreshes last-modified",
        ])
        expect(
          dedupes.probes.find((probe) => probe.name === "overwrite refreshes last-modified")
            ?.measured,
        ).toMatchObject({ settleMillis: 20, advancedMillis: 0 })

        const refreshes = yield* checkBucket(memoryBucket())(options)
        expect(refreshes.passed).toBe(true)
        expect(
          refreshes.probes.find((probe) => probe.name === "overwrite refreshes last-modified")
            ?.measured.advancedMillis,
        ).toBeGreaterThan(0)
      }),
  )
})
