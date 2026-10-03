import { describe, expect, it } from "vitest"
import { areaPath, linePath } from "./path.ts"

const controlYs = (d: string): ReadonlyArray<number> =>
  [...d.matchAll(/C([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)/gu)].flatMap((match) => [
    Number(match[2]),
    Number(match[4]),
  ])

describe("linePath", () => {
  it("joins points with straight segments for the linear curve", () => {
    expect(
      linePath({
        points: [
          { x: 0, y: 10 },
          { x: 5, y: 2.5 },
        ],
        curve: "linear",
      }),
    ).toBe("M0 10L5 2.5")
  })

  it("never overshoots a plateau with the monotone curve", () => {
    const d = linePath({
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 10 },
        { x: 3, y: 10 },
        { x: 4, y: 4 },
      ],
      curve: "monotone",
    })
    for (const y of controlYs(d)) {
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(10)
    }
  })

  it("draws nothing for no points", () => {
    expect(linePath({ points: [], curve: "monotone" })).toBe("")
  })
})

describe("areaPath", () => {
  it("closes the line down to the baseline", () => {
    expect(
      areaPath({
        points: [
          { x: 0, y: 4 },
          { x: 10, y: 2 },
        ],
        curve: "linear",
        baseline: 20,
      }),
    ).toBe("M0 4L10 2L10 20L0 20Z")
  })
})
