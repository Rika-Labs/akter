import { describe, expect, it } from "vitest"

import { originFrom } from "./build-origins.ts"

const origin = (value: string | undefined) =>
  originFrom({ name: "SITE_URL", value, fallback: "https://docs.akter.dev" })

describe("originFrom", () => {
  it("falls back to the production origin when the setting is absent", () => {
    expect(origin(undefined)).toBe("https://docs.akter.dev")
  })

  it("takes a preview origin from the build setting", () => {
    expect(origin("https://akter-pr-12-docs.akter-preview.workers.dev")).toBe(
      "https://akter-pr-12-docs.akter-preview.workers.dev",
    )
  })

  it("rejects anything that is not a bare https origin, naming the setting", () => {
    for (const value of [
      "http://docs.akter.dev",
      "https://docs.akter.dev/",
      "https://docs.akter.dev/docs",
      "https://docs.akter.dev:8443",
      "docs.akter.dev",
      "",
    ])
      expect(() => origin(value), value).toThrow(/SITE_URL must be an https origin/)
  })
})
