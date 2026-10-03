import { Duration } from "effect"
import { describe, expect, it } from "vitest"
import { isAssertionLifetime, isLeaseTiming } from "./config.ts"

describe("EDGE_ASSERTION_LIFETIME", () => {
  it("accepts whole seconds from 1 to 60 and refuses anything a claim would floor or exceed", () => {
    for (const ok of [Duration.seconds(1), Duration.seconds(10), Duration.seconds(60)])
      expect(isAssertionLifetime(ok)).toBe(true)

    for (const refused of [
      Duration.millis(500),
      Duration.millis(1500),
      Duration.zero,
      Duration.seconds(61),
    ])
      expect(isAssertionLifetime(refused)).toBe(false)
  })
})

describe("EDGE_LEASE_HEARTBEAT", () => {
  it("must be positive and at most half the lease lifetime, or a live edge's local deadline would pass between beats", () => {
    const ttl = Duration.seconds(30)

    expect(isLeaseTiming(ttl, Duration.seconds(10))).toBe(true)
    expect(isLeaseTiming(ttl, Duration.seconds(15))).toBe(true)
    expect(isLeaseTiming(ttl, Duration.millis(15_001))).toBe(false)
    expect(isLeaseTiming(ttl, Duration.seconds(30))).toBe(false)
    expect(isLeaseTiming(ttl, Duration.zero)).toBe(false)
    expect(ttl.pipe(isLeaseTiming(Duration.seconds(10)))).toBe(true)
  })
})
