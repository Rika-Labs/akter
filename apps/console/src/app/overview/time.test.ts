import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import { ago, clock, clockMillis, hourLabel, splitAddress, until } from "./time.ts"

const now = DateTime.makeUnsafe("2026-10-03T14:02:11.998Z")
const at = (iso: string) => DateTime.makeUnsafe(iso)

describe("relative time", () => {
  it("writes the largest whole unit and floors, never rounds up", () => {
    expect(ago(now)(at("2026-10-03T14:02:08.000Z"))).toBe("now")
    expect(ago(now)(at("2026-10-03T14:02:00.000Z"))).toBe("11s")
    expect(ago(now)(at("2026-10-03T13:02:12.000Z"))).toBe("59m")
    expect(ago(now)(at("2026-10-03T12:02:11.000Z"))).toBe("2h")
    expect(ago(now)(at("2026-10-02T14:02:11.000Z"))).toBe("1d")
    expect(ago(now)(at("2026-09-27T14:02:11.000Z"))).toBe("6d")
  })

  it("reads an instant in the future as now rather than a negative age", () => {
    expect(ago(now)(at("2026-10-03T14:05:00.000Z"))).toBe("now")
  })

  it("counts down to an instant and reads a past one as zero", () => {
    expect(until(now)(at("2026-10-03T14:02:32.998Z"))).toBe("in 21 s")
    expect(until(now)(at("2026-10-03T14:08:12.000Z"))).toBe("in 6 min")
    expect(until(now)(at("2026-10-03T23:30:00.000Z"))).toBe("in 9 h")
    expect(until(now)(at("2026-10-05T14:02:12.000Z"))).toBe("in 2 d")
    expect(until(now)(at("2026-10-03T13:00:00.000Z"))).toBe("in 0 s")
  })
})

describe("clock labels", () => {
  it("writes UTC regardless of the machine's time zone", () => {
    expect(clock(now)).toBe("14:02:11")
    expect(clockMillis(now)).toBe("14:02:11.998")
    expect(hourLabel(at("2026-10-03T09:05:59.000Z"))).toBe("09:05")
  })
})

describe("actor addresses", () => {
  it("splits at the first slash so a key may contain slashes", () => {
    expect(splitAddress("Order/ord_8f2c")).toEqual({ actorType: "Order", key: "ord_8f2c" })
    expect(splitAddress("Doc/a/b")).toEqual({ actorType: "Doc", key: "a/b" })
  })
})
