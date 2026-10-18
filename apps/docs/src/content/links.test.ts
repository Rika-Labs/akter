import { describe, expect, it } from "vitest"

import { type LinkEnvironment, resolveLink } from "./links.ts"

const kinds = new Map<string, "file" | "directory">([
  ["docs/contracts/02-actions.md", "file"],
  ["docs/api/README.md", "file"],
  ["apps/self-host", "directory"],
])

const headings = new Map([
  ["api/06-cli", new Set(["akter-keys"])],
  ["guides/concepts", new Set(["jobs"])],
])

const environment: LinkEnvironment = {
  routes: new Set(["quickstart", "guides/concepts", "api/06-cli", "welcome"]),
  kind: (path) => kinds.get(path),
  anchors: (slug) => headings.get(slug),
}

const resolve = (source: string, href: string) => resolveLink({ environment, source, href })

describe("resolveLink", () => {
  it("leaves external and mail links alone", () => {
    expect(resolve("quickstart", "https://example.com/a#b")).toEqual({
      href: "https://example.com/a#b",
    })
    expect(resolve("quickstart", "mailto:a@b.dev")).toEqual({ href: "mailto:a@b.dev" })
  })

  it("turns a relative link to a published page into its route and keeps the anchor", () => {
    expect(resolve("guides/concepts", "../api/06-cli.md#akter-keys")).toEqual({
      href: "/api/06-cli#akter-keys",
    })
    expect(resolve("guides/concepts", "./concepts.md")).toEqual({ href: "/guides/concepts" })
  })

  it("sends a link to an unpublished repository file to GitHub, as a directory when it is one", () => {
    expect(resolve("guides/concepts", "../contracts/02-actions.md#x")).toEqual({
      href: "https://github.com/Rika-Labs/akter/blob/main/docs/contracts/02-actions.md#x",
    })
    expect(resolve("quickstart", "../apps/self-host")).toEqual({
      href: "https://github.com/Rika-Labs/akter/tree/main/apps/self-host",
    })
  })

  it("keeps a root-relative link to a published page and rejects one that is not a route", () => {
    expect(resolve("quickstart", "/cloud-nope")).toEqual({
      problem: "/cloud-nope is not a published page",
    })
    expect(resolve("quickstart", "/api/06-cli/")).toEqual({ href: "/api/06-cli" })
  })

  it("rejects a missing file, an escape from the repository and a missing anchor", () => {
    expect(resolve("quickstart", "./gone.md")).toMatchObject({
      problem: expect.stringContaining("does not exist"),
    })
    expect(resolve("quickstart", "../../outside.md")).toMatchObject({
      problem: expect.stringContaining("leaves"),
    })
    expect(resolve("guides/concepts", "../api/06-cli.md#nope")).toEqual({
      problem: "#nope is not a heading of api/06-cli",
    })
    expect(resolve("guides/concepts", "#nope")).toEqual({
      problem: "#nope is not a heading of guides/concepts",
    })
    expect(resolve("guides/concepts", "#jobs")).toEqual({ href: "#jobs" })
  })
})
