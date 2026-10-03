import { describe, expect, it } from "vitest"
import { formatMeasurement, niceAxis, percentOf } from "./scale.ts"

describe("niceAxis", () => {
  it("rounds the largest value up to a maximum a reader can say aloud", () => {
    expect(niceAxis(1647.2)).toEqual({ max: 2000, ticks: [0, 500, 1000, 1500, 2000] })
    expect(niceAxis(532.1)).toEqual({ max: 600, ticks: [0, 200, 400, 600] })
    expect(niceAxis(5.178)).toEqual({ max: 6, ticks: [0, 2, 4, 6] })
  })

  it("keeps the axis at or above the largest value, never clipping the longest bar", () => {
    for (const largest of [0.4, 2.6, 7.3, 99, 116.144, 1626.8, 24293.4])
      expect(niceAxis(largest).max).toBeGreaterThanOrEqual(largest)
  })

  it("falls back to a unit axis for an empty chart", () => {
    expect(niceAxis(0)).toEqual({ max: 1, ticks: [0, 1] })
  })
})

describe("percentOf", () => {
  it("places a value proportionally along the axis and clamps outside it", () => {
    const axis = niceAxis(1647.2)

    expect(percentOf(1000, axis)).toBe(50)
    expect(percentOf(5000, axis)).toBe(100)
    expect(percentOf(-3, axis)).toBe(0)
  })
})

describe("formatMeasurement", () => {
  it("groups digits, keeps three decimals for latency and one for small rates", () => {
    expect(formatMeasurement(1647.2, "op/s")).toBe("1,647")
    expect(formatMeasurement(2.6, "op/s")).toBe("2.6")
    expect(formatMeasurement(0.4, "ms")).toBe("0.4")
    expect(formatMeasurement(77.868, "ms")).toBe("77.868")
    expect(formatMeasurement(116.144, "ms")).toBe("116")
  })
})
