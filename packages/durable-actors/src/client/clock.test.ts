import { describe, expect, it } from "vitest"
import { ConsistencyToken, DatabaseClock, lifetime, retryDeadline } from "./clock.ts"

const UUID = "00000000-0000-4000-8000-000000000000"

describe("DatabaseClock", () => {
  it("samples its clock offset from the fastest response", () => {
    let local = 1_000_000
    const clock = new DatabaseClock(() => local)

    clock.observe(local - 400, local, local + 10_000 - 200)
    clock.observe(local - 20, local, local + 5_000 - 10)
    clock.observe(local - 900, local, local + 90_000)

    expect(clock.now()).toBe(local + 5_000)

    local += 30_000
    expect(clock.now()).toBe(local + 5_000)
  })

  it("waits for a database time by the estimate's gap plus half its sample's round trip", () => {
    const local = 1_000_000
    const clock = new DatabaseClock(() => local)

    clock.observe(local - 300, local, local + 5_000)

    expect(clock.now()).toBe(local + 5_150)
    expect(clock.untilReached(local + 5_500)).toBe(500)
  })

  it("ignores a round trip too slow to say when the server stamped it", () => {
    const local = 1_000_000
    const clock = new DatabaseClock(() => local)

    clock.observe(local - 30_000, local, local + 3_600_000)

    expect(clock.isSampled).toBe(false)
    expect(clock.now()).toBe(local)
  })

  it("keeps a bounded set of samples under sustained traffic, retaining the fastest", () => {
    let local = 1_000_000
    const clock = new DatabaseClock(() => local)

    clock.observe(local - 2, local, local + 7_000 - 1)

    for (let index = 0; index < 1_000; index += 1) {
      local += 10
      clock.observe(local - 50, local, local + 9_000 - 25)
    }

    expect(clock.now()).toBe(local + 7_000)
  })

  it("keeps faster samples when a burst of slower responses arrives", () => {
    let local = 1_000_000
    const clock = new DatabaseClock(() => local)

    for (let index = 0; index < 16; index += 1) {
      local += 10
      clock.observe(local - 2, local, local + 7_000 - 1)
    }

    for (let index = 0; index < 16; index += 1) {
      local += 10
      clock.observe(local - 3_000, local, local + 9_000)
    }

    expect(clock.now()).toBe(local + 7_000)
  })

  it("never leads a short window by less than half the sample's round trip", () => {
    const local = 1_000_000
    const clock = new DatabaseClock(() => local)
    clock.observe(local - 800, local, local - 400)

    const span = lifetime(clock.mint(1_000, UUID))

    expect(span).toEqual({ issuedAt: local - 400, expiresAt: local + 600 })
  })

  it("keeps most of a short retry window ahead of the issue time", () => {
    const local = 1_000_000
    const clock = new DatabaseClock(() => local)
    clock.observe(local - 10, local, local - 5)

    const span = lifetime(clock.mint(1_000, UUID))

    expect(span).toEqual({ issuedAt: local - 250, expiresAt: local + 750 })
  })

  it("is fresh only while a sample from the last minute remains", () => {
    let local = 1_000_000
    const clock = new DatabaseClock(() => local)

    expect(clock.isFresh).toBe(false)
    clock.observe(local - 10, local, local + 5_000)
    expect(clock.isFresh).toBe(true)

    local += 60_000
    expect(clock.isFresh).toBe(false)
    expect(clock.isSampled).toBe(true)
  })

  it("mints ids behind the database clock with the deployment's window", () => {
    const local = 1_000_000
    const clock = new DatabaseClock(() => local)
    clock.observe(local - 10, local, local + 600_000 - 5)

    const id = clock.mint(86_400_000, UUID)
    const span = lifetime(id)

    expect(id.endsWith(UUID)).toBe(true)
    expect(span).toEqual({
      issuedAt: local + 600_000 - 1_000,
      expiresAt: local + 600_000 - 1_000 + 86_400_000,
    })
  })
})

describe("lifetime", () => {
  it("reads v1 ids and nothing else", () => {
    expect(lifetime(`v1.1.2.${UUID}`)).toEqual({ issuedAt: 1, expiresAt: 2 })
    expect(lifetime(`v2.1.2.${UUID}`)).toBeUndefined()
    expect(lifetime("order-1")).toBeUndefined()
  })
})

describe("retryDeadline", () => {
  it("stops retries a second before expiry, or a quarter of a shorter window", () => {
    expect(retryDeadline(`v1.0.86400000.${UUID}`)).toBe(86_399_000)
    expect(retryDeadline(`v1.1000.2000.${UUID}`)).toBe(1_750)
    expect(retryDeadline("order-1")).toBeUndefined()
  })
})

describe("ConsistencyToken", () => {
  it("keeps the greatest decimal token by length then digits, never as a number", () => {
    const token = new ConsistencyToken()

    for (const seen of ["9", "10", "9", "not-a-token", "-1", "01", null, "99999999999999999999"])
      token.observe(seen)

    expect(token.value).toBe("99999999999999999999")

    token.observe("99999999999999999998")
    expect(token.value).toBe("99999999999999999999")

    token.observe("100000000000000000000")
    expect(token.value).toBe("100000000000000000000")
  })
})
