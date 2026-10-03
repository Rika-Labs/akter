import { describe, expect, it } from "vitest"
import { defaults, estimate, included } from "./estimate.ts"

const total = (overrides: Partial<typeof defaults>): number =>
  estimate({ ...defaults, ...overrides }).total

describe("estimate", () => {
  it("prices the default month at $127.60: Pro, 190 runner hours over, 400 GB over", () => {
    const result = estimate(defaults)

    expect(result.plan.name).toBe("Pro")
    expect(result.lines.map((line) => line.amount)).toEqual([20, 0, 7.6, 100, 0])
    expect(result.total).toBe(127.6)
  })

  it("charges nothing beyond the plan inside every included allowance", () => {
    const result = estimate({
      commands: included.commands,
      runners: 2,
      storageGb: included.storageGb,
      egressGb: included.egressGb,
      regions: 1,
    })

    expect(result.total).toBe(20)
  })

  it("charges each usage line only for the units above its allowance, on both sides of the edge", () => {
    expect(total({ runners: 2 })).toBeCloseTo(120)
    expect(total({ runners: 3 })).toBeCloseTo(127.6)
    expect(total({ runners: 4 })).toBeCloseTo(156.8)
    expect(total({ storageGb: 100 })).toBeCloseTo(27.6)
    expect(total({ storageGb: 101 })).toBeCloseTo(27.85)
    expect(total({ commands: 101_000_000 })).toBeCloseTo(127.8)
    expect(total({ egressGb: 1000 })).toBeCloseTo(127.6)
    expect(total({ egressGb: 1001 })).toBeCloseTo(127.65)
  })

  it("moves to Team at two regions and keeps the same usage rules", () => {
    const result = estimate({ ...defaults, regions: 2 })

    expect(result.plan.name).toBe("Team")
    expect(result.lines[0]?.amount).toBe(250)
    expect(result.total).toBeCloseTo(357.6)
  })

  it("prices the largest month the page offers", () => {
    const result = estimate({
      commands: 1_000_000_000,
      runners: 12,
      storageGb: 1000,
      egressGb: 100,
      regions: 5,
    })

    expect(result.lines.map((line) => line.amount)).toEqual([250, 180, 270.4, 225, 0])
    expect(result.total).toBeCloseTo(925.4)
  })
})
