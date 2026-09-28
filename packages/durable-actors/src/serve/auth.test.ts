import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { User } from "../identity/caller.ts"
import { Credential, make, none, readsCookies } from "./auth.ts"

const authenticate = () => Effect.succeed({ caller: User.make({ subject: "s" }), tenant: "t" })

describe("Actor.auth.make", () => {
  it("accepts a bearer token unless the provider names a cookie, and both when it also sets bearer", () => {
    expect(make(authenticate).credentials).toEqual([Credential.Bearer()])
    expect(make({ authenticate }).credentials).toEqual([Credential.Bearer()])

    expect(make({ authenticate, cookies: { name: "session" } }).credentials).toEqual([
      Credential.Cookie({ name: "session" }),
    ])

    expect(make({ authenticate, cookies: { name: "session" }, bearer: true }).credentials).toEqual([
      Credential.Bearer(),
      Credential.Cookie({ name: "session" }),
    ])
  })

  it("gives cookies only to a provider with a cookie credential", () => {
    expect(readsCookies(none)).toBe(false)
    expect(readsCookies(make(authenticate))).toBe(false)
    expect(readsCookies(make({ authenticate, cookies: { name: "__Host-sid" } }))).toBe(true)
  })

  it("rejects a cookie name that is not an HTTP token", () => {
    for (const name of ["", "my session", "a;b", "a=b", "é"])
      expect(() => make({ authenticate, cookies: { name } })).toThrow(/is not a cookie name/)
  })
})
