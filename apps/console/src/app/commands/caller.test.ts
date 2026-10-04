import { describe, expect, it } from "vitest"
import { callerText } from "./caller.ts"

const signedIn = callerText({ id: "usr_dallen", name: "Dallen Pyrah" })

describe("caller words", () => {
  it("names the signed-in member's own commands and writes any other member as the subject", () => {
    expect(signedIn({ kind: "user", subject: "user:usr_dallen", source: null })).toBe(
      "Dallen Pyrah",
    )
    expect(signedIn({ kind: "user", subject: "user:usr_lee", source: null })).toBe("user:usr_lee")
    expect(signedIn({ kind: "user", subject: "user:usr_dallen_2", source: null })).toBe(
      "user:usr_dallen_2",
    )
  })

  it("never matches a member without an id, even against a subject naming undefined", () => {
    expect(
      callerText({ name: "Dallen Pyrah" })({
        kind: "user",
        subject: "user:undefined",
        source: null,
      }),
    ).toBe("user:undefined")
  })

  it("writes the subject when the session has no member to compare with", () => {
    const keySession = callerText({ name: "" })
    expect(keySession({ kind: "user", subject: "user:usr_dallen", source: null })).toBe(
      "user:usr_dallen",
    )
    expect(
      callerText({ id: "usr_dallen", name: "" })({
        kind: "user",
        subject: "user:usr_dallen",
        source: null,
      }),
    ).toBe("user:usr_dallen")
  })

  it("writes an API key as its last six id characters, never as a member", () => {
    expect(signedIn({ kind: "user", subject: "api-key:key_01J9ZK3QWX", source: null })).toBe(
      "API key …ZK3QWX",
    )
    expect(
      callerText({ id: "key_01J9ZK3QWX", name: "Dallen Pyrah" })({
        kind: "user",
        subject: "api-key:key_01J9ZK3QWX",
        source: null,
      }),
    ).toBe("API key …ZK3QWX")
  })

  it("keeps an application's own subject as written", () => {
    expect(signedIn({ kind: "user", subject: "alice@example.com", source: null })).toBe(
      "alice@example.com",
    )
  })

  it("writes framework deliveries and unauthenticated callers as words", () => {
    expect(signedIn({ kind: "system", subject: "user:usr_dallen", source: "timer" })).toBe("System")
    expect(signedIn({ kind: "system", subject: null, source: "cron" })).toBe("System")
    expect(signedIn({ kind: "anonymous", subject: null, source: null })).toBe("Anonymous")
  })

  it("writes an unreported caller, or a user without a subject, as a dash", () => {
    expect(signedIn(null)).toBe("—")
    expect(signedIn({ kind: "user", subject: null, source: null })).toBe("—")
  })
})
