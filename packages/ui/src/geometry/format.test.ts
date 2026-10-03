import { describe, expect, it } from "vitest"
import { formatCompact, formatCurrency, formatDuration, formatPercent } from "./format.ts"

describe("formatCompact", () => {
  it("keeps small counts whole and abbreviates large ones", () => {
    expect(formatCompact(1_284)).toBe("1,284")
    expect(formatCompact(12_904)).toBe("12.9K")
    expect(formatCompact(41_200_000)).toBe("41.2M")
    expect(formatCompact(2_000_000)).toBe("2M")
    expect(formatCompact(276_000)).toBe("276K")
  })
})

describe("formatDuration", () => {
  it("switches units at ten milliseconds, a second and a minute", () => {
    expect(formatDuration(4.1)).toBe("4.1 ms")
    expect(formatDuration(51)).toBe("51 ms")
    expect(formatDuration(1_800)).toBe("1.8 s")
    expect(formatDuration(41_000)).toBe("41 s")
    expect(formatDuration(252_000)).toBe("4 m 12 s")
  })
})

describe("formatPercent and formatCurrency", () => {
  it("formats shares and dollars the way billing reads them", () => {
    expect(formatPercent(0.412)).toBe("41%")
    expect(formatPercent(0.004)).toBe("0.4%")
    expect(formatCurrency(206.7)).toBe("$206.70")
    expect(formatCurrency(1_188.4)).toBe("$1,188.40")
  })
})
