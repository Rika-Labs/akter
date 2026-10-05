import { describe, expect, it } from "vitest"
import { longDate, shortDate } from "./dates.ts"

describe("dates", () => {
  it("prints the day without a leading zero and the month in full or abbreviated", () => {
    expect(shortDate("2026-10-04")).toBe("Oct 4, 2026")
    expect(longDate("2026-10-04")).toBe("October 4, 2026")
    expect(longDate("2026-12-31")).toBe("December 31, 2026")
  })

  it("rejects a date that is not ISO", () => {
    expect(() => shortDate("2026-13-01")).toThrow()
    expect(() => shortDate("soon")).toThrow()
  })
})
