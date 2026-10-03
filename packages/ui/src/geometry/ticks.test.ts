import { describe, expect, it } from "vitest"
import { labelIndices, niceStep, niceTicks } from "./ticks.ts"

describe("niceTicks", () => {
  it("widens an uneven domain to round ends with round steps", () => {
    const axis = niceTicks({ min: 3, max: 97, count: 5 })
    expect(axis.ticks).toEqual([0, 20, 40, 60, 80, 100])
    expect([axis.min, axis.max]).toEqual([0, 100])
  })

  it("chooses 2.5 and 5 multiples instead of drifting to awkward steps", () => {
    expect(niceStep({ span: 12, count: 5 })).toBe(2.5)
    expect(niceStep({ span: 11, count: 5 })).toBe(2)
    expect(niceStep({ span: 47, count: 5 })).toBe(10)
    expect(niceStep({ span: 4_200, count: 4 })).toBe(1_000)
  })

  it("prints decimal ticks without floating point noise", () => {
    expect(niceTicks({ min: 0, max: 0.3, count: 3 }).ticks).toEqual([0, 0.1, 0.2, 0.3])
  })

  it("gives a constant series an axis above its value instead of a zero span", () => {
    const axis = niceTicks({ min: 5, max: 5, count: 4 })
    expect(axis.min).toBeLessThanOrEqual(5)
    expect(axis.max).toBeGreaterThan(5)
  })
})

describe("labelIndices", () => {
  it("keeps both ends and spreads the rest evenly", () => {
    expect(labelIndices({ length: 96, count: 5 })).toEqual([0, 24, 48, 71, 95])
  })

  it("labels every point when there are fewer points than labels", () => {
    expect(labelIndices({ length: 3, count: 5 })).toEqual([0, 1, 2])
  })
})
