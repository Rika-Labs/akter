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
      if (yield* bucket.exists(key)) return false
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

describe("checkBucket", () => {
  it.effect(
    "fails a bucket whose conditional create and compare-and-swap are not atomic, and passes the same bucket with atomic ones (rejects a probe that never races its writers)",
    () =>
      Effect.gen(function* () {
        const options = { writers: 8, rounds: 3, writes: 3 }
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
})
