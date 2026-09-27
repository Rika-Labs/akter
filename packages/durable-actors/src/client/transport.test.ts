import { describe, expect, it } from "vitest"
import { retryAfterHeader } from "./transport.ts"

describe("retryAfterHeader", () => {
  it("reads delay seconds", () => {
    expect(retryAfterHeader(new Headers({ "retry-after": " 3 " }))).toBe(3_000)
  })

  it("measures an HTTP date from the response's date", () => {
    expect(
      retryAfterHeader(
        new Headers({
          "retry-after": "Wed, 21 Oct 2026 07:28:05 GMT",
          date: "Wed, 21 Oct 2026 07:28:00 GMT",
        }),
      ),
    ).toBe(5_000)
  })

  it("ignores a date without a response date, and junk", () => {
    expect(
      retryAfterHeader(new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:05 GMT" })),
    ).toBeUndefined()
    expect(retryAfterHeader(new Headers({ "retry-after": "soon", date: "x" }))).toBeUndefined()
    expect(retryAfterHeader(new Headers())).toBeUndefined()
  })
})
