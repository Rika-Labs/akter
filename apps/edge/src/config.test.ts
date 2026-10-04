import { ConfigProvider, Duration, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { isAssertionLifetime, isLeaseTiming, loadOptions } from "./config.ts"

const required = {
  EDGE_ISSUER: "http://edge.test",
  CONTROL_PLANE_DATABASE_URL: "postgres://edge.test/control",
  EDGE_SIGNING_KEYS: JSON.stringify([{ kid: "test-key", x: "public-half", d: "private-half" }]),
}

const load = (environment: Record<string, string>) =>
  Effect.runSyncExit(
    loadOptions.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ ...required, ...environment }),
      ),
    ),
  )

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

describe("EDGE_PUBLICATION_LEAD", () => {
  it("defaults to the runners' five-minute key-set refresh", () => {
    const options = load({})

    expect(Exit.isSuccess(options) && Duration.toMillis(options.value.publicationLead)).toBe(
      300_000,
    )
  })

  it("takes a shorter lead for local development, including none", () => {
    for (const [value, ms] of [
      ["7 seconds", 7_000],
      ["0 seconds", 0],
    ] as const) {
      const options = load({ EDGE_PUBLICATION_LEAD: value })

      expect(Exit.isSuccess(options) && Duration.toMillis(options.value.publicationLead)).toBe(ms)
    }
  })

  it("refuses a lead that is not a duration", () => {
    expect(Exit.isFailure(load({ EDGE_PUBLICATION_LEAD: "soon" }))).toBe(true)
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
