import { describe, expect, it } from "vitest"
import { deployment, assertDestroy } from "../src/lifecycle.ts"

const now = Date.parse("2026-09-01T00:00:00Z")

const dev = {
  project: "app",
  stage: "dev",
  owner: "alice",
  id: "work",
  expiresAt: "2026-09-02T00:00:00Z",
} as const

describe("remote lifecycle", () => {
  it("names by project, stage, owner and identity", () => {
    expect(deployment({ input: dev, now }).key).toBe("app-dev-alice-work")
    expect(deployment({ input: { ...dev, owner: "bob" }, now }).key).not.toBe(
      deployment({ input: dev, now }).key,
    )
  })
  it("rejects absent, expired and excessive TTL", () => {
    for (const expiresAt of [undefined, "invalid", "2026-09-01T00:00:00Z", "2026-09-09T00:00:00Z"])
      expect(() => deployment({ input: { ...dev, expiresAt }, now })).toThrow()
  })
  it("protects persistent stages and foreign owners", () => {
    expect(() => assertDestroy({ input: { ...dev, stage: "prod" }, actor: "alice", now })).toThrow(
      "protected",
    )
    expect(() => assertDestroy({ input: dev, actor: "bob", now })).toThrow("another owner")
    expect(assertDestroy({ input: dev, actor: "alice", now })).toEqual({ expired: false })
    expect(assertDestroy({ input: dev, actor: "alice", now: now + 86400000 })).toEqual({
      expired: true,
    })
  })
})
