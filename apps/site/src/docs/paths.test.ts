import { describe, expect, it } from "vitest"
import { markdownUrlFor, resolveLink, rewriteLinks, slugFor, urlFor } from "./paths.ts"

const table = new Map([
  ["quickstart.md", "quickstart"],
  ["guides/concepts.md", "concepts"],
  ["api/README.md", "api/overview"],
  ["api/01-server-api.md", "api/server-api"],
])

describe("slugFor", () => {
  it("flattens guides, keeps the api prefix, drops numeric prefixes and names the api README", () => {
    expect(slugFor("quickstart")).toBe("quickstart")
    expect(slugFor("guides/effect-into-the-commit")).toBe("effect-into-the-commit")
    expect(slugFor("product/fit-and-non-fit")).toBe("fit-and-non-fit")
    expect(slugFor("api/01-server-api")).toBe("api/server-api")
    expect(slugFor("api/README.md")).toBe("api/overview")
    expect(slugFor("api/naming")).toBe("api/naming")
  })

  it("serves the quickstart as the docs home and every page's Markdown beside it", () => {
    expect(urlFor("quickstart")).toBe("/docs")
    expect(urlFor("api/cli")).toBe("/docs/api/cli")
    expect(markdownUrlFor("quickstart")).toBe("/docs/quickstart.md")
  })
})

describe("resolveLink", () => {
  it("points a rendered page at its site URL and keeps the anchor", () => {
    expect(resolveLink("../api/01-server-api.md#overflow", "guides/concepts.md", table)).toBe(
      "/docs/api/server-api#overflow",
    )
    expect(resolveLink("../quickstart.md", "guides/concepts.md", table)).toBe("/docs")
    expect(resolveLink("01-server-api.md", "api/README.md", table)).toBe("/docs/api/server-api")
  })

  it("sends repository-only documents to GitHub, files as blob and folders as tree", () => {
    expect(resolveLink("../contracts/README.md", "guides/README.md", table)).toBe(
      "https://github.com/Rika-Labs/akter/blob/main/docs/contracts/README.md",
    )
    expect(resolveLink("../decisions/", "guides/concepts.md", table)).toBe(
      "https://github.com/Rika-Labs/akter/tree/main/docs/decisions",
    )
    expect(resolveLink("../../README.md", "guides/concepts.md", table)).toBe(
      "https://github.com/Rika-Labs/akter/blob/main/README.md",
    )
  })

  it("leaves anchors and absolute URLs alone", () => {
    expect(resolveLink("#what-it-is", "quickstart.md", table)).toBe("#what-it-is")
    expect(resolveLink("https://pglite.dev", "quickstart.md", table)).toBe("https://pglite.dev")
    expect(resolveLink("mailto:a@b.c", "quickstart.md", table)).toBe("mailto:a@b.c")
  })

  it("points in-site links at absolute raw Markdown for agents", () => {
    expect(resolveLink("concepts.md#turns", "guides/testing.md", table, true)).toBe(
      "https://akter.dev/docs/concepts.md#turns",
    )
  })
})

describe("rewriteLinks", () => {
  it("rewrites prose links but never text inside fenced code", () => {
    const source = [
      "See [concepts](concepts.md) and [the site](https://akter.dev).",
      "```ts",
      "const link = [a](concepts.md)",
      "```",
      'Then [quickstart](../quickstart.md "Start").',
    ].join("\n")

    expect(rewriteLinks(source, "guides/testing.md", table)).toBe(
      [
        "See [concepts](https://akter.dev/docs/concepts.md) and [the site](https://akter.dev).",
        "```ts",
        "const link = [a](concepts.md)",
        "```",
        'Then [quickstart](https://akter.dev/docs/quickstart.md "Start").',
      ].join("\n"),
    )
  })
})
