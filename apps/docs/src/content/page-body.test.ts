import remarkParse from "remark-parse"
import remarkStringify from "remark-stringify"
import { unified } from "unified"
import { describe, expect, it } from "vitest"

import { publishedSlugs } from "./navigation.ts"
import { pageBody } from "./page-body.ts"
import { remarkAdmonitionTags } from "./remark-docs.ts"

describe("pageBody", () => {
  it("rewrites every link of every published page, so one dead link anywhere fails this test", () => {
    for (const slug of publishedSlugs) {
      const body = pageBody(slug)

      expect(body, slug).not.toMatch(/\]\((?:\.{1,2}\/|(?![a-z]+:|\/)[^)]*\.md[)#])/)
    }
  })

  it("drops the leading heading and frontmatter", () => {
    const body = pageBody("getting-started")

    expect(body).not.toMatch(/^# /m)
    expect(body.startsWith("In this tutorial")).toBe(true)
    expect(body).not.toContain("title:")
  })

  it("turns the warning tag into a quote and keeps its text", () => {
    const body = String(
      unified()
        .use(remarkParse)
        .use(remarkAdmonitionTags)
        .use(remarkStringify)
        .processSync("<Warning>\nPin the commit you deploy.\n</Warning>\n"),
    )

    expect(body).not.toContain("<Warning>")
    expect(body).toMatch(/^> Pin the commit you deploy\./m)
  })

  it("sends links to unpublished documents to GitHub and between published pages to routes", () => {
    expect(pageBody("guides/client")).toContain(
      "](https://github.com/Rika-Labs/akter/blob/main/docs/internals/contracts/protocol.md)",
    )
    expect(pageBody("deploy/overview")).toContain("](/reference/cli#akter-storage-check)")
  })
})
