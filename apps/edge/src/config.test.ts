import { Duration } from "effect"
import { describe, expect, it } from "vitest"
import { isAssertionLifetime } from "./config.ts"

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
