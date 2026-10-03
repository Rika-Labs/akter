import { describe, expect, it } from "vitest"
import { rolloutLayout } from "./rollout.ts"

describe("rolloutLayout", () => {
  const layout = rolloutLayout({
    phases: [
      { id: "build", label: "Build", detail: "", start: 0, end: 12 },
      { id: "drain", label: "Drain", detail: "", start: 30, end: 41 },
    ],
    shift: { start: 18, end: 38 },
  })

  it("places phases on an axis rounded up past the last phase", () => {
    expect(layout.span).toBe(50)
    expect(layout.bars[0]?.width).toBeCloseTo(12 / 50)
    expect(layout.bars[1]?.left).toBeCloseTo(30 / 50)
    expect(layout.ticks.at(-1)?.position).toBe(1)
  })

  it("moves traffic only during the shift, rising without dips", () => {
    const before = layout.share.filter((point) => point.x * layout.span <= 18)
    const after = layout.share.filter((point) => point.x * layout.span >= 38)
    expect(before.every((point) => point.y === 0)).toBe(true)
    expect(after.every((point) => point.y === 1)).toBe(true)
    layout.share.slice(1).forEach((point, index) => {
      expect(point.y).toBeGreaterThanOrEqual(layout.share[index]?.y ?? 0)
    })
  })
})
