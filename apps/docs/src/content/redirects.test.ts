import { describe, expect, it } from "vitest"

import { publishedSlugs } from "./navigation.ts"
import { redirects } from "./redirects.ts"

const routes = new Set(["welcome", ...publishedSlugs])

const legacySources = [
  "/cloud/bring-your-database",
  "/contracts/02-command-turns",
  "/contracts/03-transactions",
  "/contracts/04-receipts",
  "/contracts/06-storage-ownership",
  "/contracts/*",
  "/decisions/*",
  "/milestones/*",
  "/BENCHMARKS",
  "/product/competitive-positioning",
  "/packages/*",
  "/api/04-drizzle",
  "/api/05-generated-clients",
  "/api/post-foundation-sketches",
  "/architecture/data-model",
  "/architecture/transaction-catalog",
  "/cloud/choose-postgres",
  "/cloud/database",
  "/operations/inspection-views",
  "/vision/03-relational-data",
  "/guides/effect-into-the-commit",
]

describe("redirects", () => {
  it("keeps every address that used to redirect, once", () => {
    const sources = redirects.map((redirect) => redirect.source)

    for (const legacy of legacySources) expect(sources, legacy).toContain(legacy)
    expect(new Set(sources).size).toBe(sources.length)
  })

  it("sends every source to a published page or an external address", () => {
    for (const redirect of redirects) {
      if (redirect.destination.startsWith("https://")) continue

      expect(redirect.destination.startsWith("/"), redirect.source).toBe(true)
      expect(routes, redirect.source).toContain(redirect.destination.slice(1))
    }
  })

  it("never shadows a published page", () => {
    for (const redirect of redirects)
      expect(routes, redirect.source).not.toContain(redirect.source.slice(1))
  })

  it("passes a splat through, and only where the source has one", () => {
    for (const redirect of redirects)
      expect(redirect.source.endsWith("/*"), redirect.source).toBe(
        redirect.destination.includes(":splat"),
      )
  })

  it("lists static sources before splat sources so the specific rule wins", () => {
    const firstSplat = redirects.findIndex((redirect) => redirect.source.includes("*"))

    expect(
      redirects.slice(firstSplat).some((redirect) => redirect.source.startsWith("/contracts/0")),
    ).toBe(false)
  })
})
