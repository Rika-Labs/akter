import { describe, expect, it } from "vitest"
import { retryAfterHeader } from "./transport.ts"

describe("retryAfterHeader", () => {
  it("reads delay seconds", () => {
    expect(retryAfterHeader({ headers: new Headers({ "retry-after": " 3 " }) })).toBe(3_000)
  })

  it("measures an HTTP date from the response's date", () => {
    expect(
      retryAfterHeader({
        headers: new Headers({
          "retry-after": "Wed, 21 Oct 2026 07:28:05 GMT",
          date: "Wed, 21 Oct 2026 07:28:00 GMT",
        }),
        now: 0,
      }),
    ).toBe(5_000)
  })

  it("measures an HTTP date without a response date from now", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")
    const at = new Headers({ "retry-after": "Wed, 21 Oct 2026 07:29:00 GMT" })

    expect(retryAfterHeader({ headers: at, now })).toBe(60_000)
    expect(retryAfterHeader({ headers: at, now: now + 120_000 })).toBe(0)
    expect(retryAfterHeader({ headers: at })).toBeUndefined()
  })

  it("ignores junk", () => {
    expect(
      retryAfterHeader({ headers: new Headers({ "retry-after": "soon", date: "x" }), now: 0 }),
    ).toBeUndefined()
    expect(retryAfterHeader({ headers: new Headers() })).toBeUndefined()
  })
})
