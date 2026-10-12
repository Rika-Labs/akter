import { describe, expect, it } from "vitest"
import { compareMetric, percentile } from "./results.ts"

describe("nearest-rank and repeat comparisons", () => {
  it("rejects floor-index percentiles, pooled repeats and manufactured empty samples", () => {
    expect(percentile([91, 3, 17, 8], 0.5)).toBe(8)
    expect(percentile([91, 3, 17, 8], 0.99)).toBe(91)
    expect(percentile([], 0.99)).toBeNull()
    expect(() => percentile([3], 0)).toThrow()
    expect(() => percentile([3], Number.NaN)).toThrow()
    const compared = compareMetric([3, 17, 8], [2, 5, 4], true)
    expect(compared.base).toEqual({ median: 8, min: 3, max: 17 })
    expect(compared.head).toEqual({ median: 4, min: 2, max: 5 })
    expect(compared.verdict).toBe("overlapping")
  })

  it("flags only disjoint ranges and reverses throughput direction", () => {
    expect(compareMetric([10, 11, 12], [7, 8, 9], true).verdict).toBe("improved")
    expect(compareMetric([10, 11, 12], [7, 8, 9], false).verdict).toBe("regressed")
    expect(compareMetric([10, 11, 12], [8, 9, 10], true).verdict).toBe("overlapping")
    expect(() => compareMetric([10, 11], [8, 9], true)).toThrow()
  })
})
