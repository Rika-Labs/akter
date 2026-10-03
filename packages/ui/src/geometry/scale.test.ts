import { describe, expect, it } from "vitest"
import { bandScale, extent, linearScale, logScale } from "./scale.ts"

describe("linearScale", () => {
  it("maps onto an inverted range, as SVG y does, and inverts back", () => {
    const y = linearScale({ domain: [0, 200], range: [120, 0] })
    expect(y.map(50)).toBe(90)
    expect(y.invert(90)).toBe(50)
  })

  it("centres a zero-width domain instead of dividing by zero", () => {
    expect(linearScale({ domain: [4, 4], range: [0, 100] }).map(4)).toBe(50)
  })
})

describe("logScale", () => {
  it("gives each decade the same width", () => {
    const x = logScale({ domain: [1, 1000], range: [0, 300] })
    expect(x.map(10)).toBeCloseTo(100)
    expect(x.map(100)).toBeCloseTo(200)
    expect(x.map(0)).toBe(0)
  })
})

describe("bandScale", () => {
  it("splits padding evenly so the outer gaps match the inner ones", () => {
    const bands = bandScale({ count: 4, range: [0, 100], padding: 0.2 })
    expect(bands.bandwidth).toBe(20)
    expect(bands.start(0)).toBe(2.5)
    expect(bands.start(3) + bands.bandwidth).toBe(97.5)
  })
})

describe("extent", () => {
  it("finds the low and high ends regardless of order", () => {
    expect(extent([7, -2, 30, 4])).toEqual([-2, 30])
  })
})
