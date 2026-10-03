import { describe, expect, it } from "vitest"
import { usageValueText } from "./usage.ts"

describe("meter value encoding", () => {
  it("keeps exact command counts and fifth-command reads unchanged", () => {
    for (const value of [0, 1, 12.4, 0.2, 999_999_999_999_999, 1_000_000_000_000_000]) {
      expect(usageValueText(value)).toBe(String(value))
    }
  })

  it("quantizes a storage value deterministically to fifteen significant digits without changing its cent charge", () => {
    const logicalValue = 53 / (1_000_000_000 * 744)
    const wire = usageValueText(logicalValue)
    expect(wire).toBe("0.0000000000712365591397849")
    expect(usageValueText(logicalValue)).toBe(wire)
    const rawCents = logicalValue * 30
    const wireCents = Number(wire) * 30
    expect(Math.abs(rawCents - wireCents)).toBeLessThan(0.00000001)
    expect(Math.ceil(wireCents)).toBe(Math.ceil(rawCents))
  })
  it("expands exponents without rounding small usage away or retaining exponent notation", () => {
    expect(usageValueText(12.4)).toBe("12.4")
    expect(usageValueText(0.21345)).toBe("0.21345")
    expect(usageValueText(1e-20)).toBe("0.00000000000000000001")
    expect(usageValueText(1.2345e-8)).toBe("0.000000012345")
    expect(usageValueText(1e21)).toBe("1000000000000000000000")
  })
})
