import { describe, expect, it } from "vitest"

import { publishedSlugs } from "./navigation.ts"
import { pageBody } from "./page-body.ts"

describe("pageBody", () => {
  it("rewrites every link of every published page, so one dead link anywhere fails this test", () => {
    for (const slug of publishedSlugs) {
      const body = pageBody(slug)

      expect(body, slug).not.toMatch(/\]\((?:\.{1,2}\/|(?![a-z]+:|\/)[^)]*\.md[)#])/)
    }
  })

  it("drops the leading heading and frontmatter", () => {
    const body = pageBody("guides/concepts")

    expect(body.startsWith("## ")).toBe(true)
    expect(body).not.toContain("title:")
  })

  it("turns the Mintlify warning tag into a quote and keeps its text", () => {
    const body = pageBody("operations/self-host")

    expect(body).not.toContain("<Warning>")
    expect(body).toMatch(/^> This recipe tracks `main`/m)
  })

  it("sends links to unpublished documents to GitHub and between published pages to routes", () => {
    expect(pageBody("guides/concepts")).toContain(
      "](https://github.com/Rika-Labs/akter/blob/main/docs/contracts/02-actions.md)",
    )
    expect(pageBody("operations/self-host")).toContain(
      "](/api/01-server-api#several-runners-and-graceful-shutdown-02)",
    )
  })
})
