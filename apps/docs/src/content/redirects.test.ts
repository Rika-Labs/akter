import { describe, expect, it } from "vitest"

import { publishedSlugs } from "./navigation.ts"
import { redirects } from "./redirects.ts"

const routes = new Set(["welcome", ...publishedSlugs])

const resolve = (path: string) =>
  redirects.find((redirect) =>
    redirect.source.endsWith("/*")
      ? path.startsWith(redirect.source.slice(0, -1))
      : redirect.source === path,
  )

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
  "/quickstart",
  "/guides/concepts",
  "/guides/actions-and-jobs",
  "/guides/deploy",
  "/guides/comparison",
  "/product/fit-and-non-fit",
  "/api/01-server-api",
  "/api/02-context",
  "/api/03-typescript-sdk",
  "/api/06-cli",
  "/api/07-cloud-logs",
  "/api/08-cloud-usage",
  "/api/09-environment-api-keys",
  "/api/forks",
  "/api/generated-contracts",
  "/api/jobs",
  "/api/lists-and-find",
  "/api/naming",
  "/api/versioning",
  "/operations/self-host",
  "/operations/01-deployment",
  "/operations/02-migrations",
  "/operations/03-observability",
  "/operations/04-backup-restore",
  "/operations/retention",
  "/operations/runbooks",
  "/operations/support-matrix",
  "/operations/alpha-upgrades",
  "/operations/05-releasing",
  "/cloud/get-started",
  "/cloud/storage",
  "/cloud/deploy",
  "/cloud/environment-variables",
  "/cloud/logs",
  "/cloud/pricing-and-limits",
  "/cloud/account-and-data",
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

  it("resolves every static source to itself, so no splat rule above it shadows it", () => {
    for (const redirect of redirects)
      if (!redirect.source.includes("*"))
        expect(resolve(redirect.source)?.source, redirect.source).toBe(redirect.source)
  })

  it("sends a bare directory address, with or without a slash, to the directory, not to an empty splat", () => {
    for (const redirect of redirects.filter((candidate) => candidate.source.endsWith("/*"))) {
      const directory = redirect.source.slice(0, -2)

      for (const path of [directory, `${directory}/`]) {
        const found = resolve(path)

        expect(found, path).toBeDefined()
        expect(found?.destination, path).not.toMatch(/\/\.md$|\/\/$/)
        expect(found?.destination, path).not.toContain(":splat")
      }
    }
  })
})
