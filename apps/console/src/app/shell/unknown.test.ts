import { describe, expect, it } from "vitest"
import { knownTotal, orUnknown } from "./unknown.ts"

describe("unknown values", () => {
  it("formats a reported value, zero included, and writes an unreported one as a dash", () => {
    const count = orUnknown((value: number) => `${String(value)} turns`)
    expect(count(0)).toBe("0 turns")
    expect(count(12)).toBe("12 turns")
    expect(count(null)).toBe("—")
  })

  it("adds reported counts and makes the total unknown when any one is unreported", () => {
    expect(knownTotal([3, 0, 4])).toBe(7)
    expect(knownTotal([3, null, 4])).toBeNull()
    expect(knownTotal([null])).toBeNull()
    expect(knownTotal([])).toBe(0)
  })
})
