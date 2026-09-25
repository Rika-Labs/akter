import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { load, shuffled, summarize } from "./measure.ts"

describe("summarize", () => {
  it("reports nearest-rank percentiles that are observed samples", () => {
    const summary = summarize(Array.from({ length: 100 }, (_, index) => index + 1))

    expect(summary).toMatchObject({
      count: 100,
      min: 1,
      p50: 50,
      p90: 90,
      p95: 95,
      p99: 99,
      max: 100,
    })
    expect(summary.mean).toBe(50.5)
  })

  it("summarizes an empty run as zeros", () => {
    expect(summarize([])).toMatchObject({ count: 0, p99: 0 })
  })
})

describe("load", () => {
  it("runs exactly the requested operations across workers and counts failures", () => {
    const seen: Array<number> = []

    return Effect.runPromise(
      load({
        workers: 4,
        operations: 20,
        operation: (index) =>
          index % 5 === 0 ? Effect.fail("boom") : Effect.sync(() => seen.push(index)),
      }),
    ).then((result) => {
      expect(result.samples).toHaveLength(16)
      expect(result.errors).toBe(4)
      expect(new Set(seen).size).toBe(16)
    })
  })
})

describe("shuffled", () => {
  it("is a deterministic permutation", () => {
    const order = shuffled(1000)

    expect(new Set(order).size).toBe(1000)
    expect(order).toEqual(shuffled(1000))
    expect(order).not.toEqual(Array.from({ length: 1000 }, (_, index) => index))
  })
})
