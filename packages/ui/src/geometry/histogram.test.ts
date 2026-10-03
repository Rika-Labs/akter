import { describe, expect, it } from "vitest"
import { bucketQuantile, toBuckets } from "./histogram.ts"

describe("bucketQuantile", () => {
  const buckets = [
    { upper: 1, count: 10 },
    { upper: 2, count: 30 },
    { upper: 4, count: 50 },
    { upper: 8, count: 10 },
  ]

  it("interpolates inside the bucket that crosses the quantile", () => {
    expect(bucketQuantile({ buckets, quantile: 0.5 })).toBeCloseTo(2.4)
    expect(bucketQuantile({ buckets, quantile: 0.95 })).toBeCloseTo(6)
  })

  it("is zero for an empty histogram", () => {
    expect(bucketQuantile({ buckets: [{ upper: 1, count: 0 }], quantile: 0.99 })).toBe(0)
  })
})

describe("toBuckets", () => {
  it("counts each value in the first bucket whose upper edge holds it", () => {
    expect(toBuckets({ values: [0.5, 1, 1.5, 9], edges: [1, 2, 4] })).toEqual([
      { upper: 1, count: 2 },
      { upper: 2, count: 1 },
      { upper: 4, count: 0 },
    ])
  })
})
