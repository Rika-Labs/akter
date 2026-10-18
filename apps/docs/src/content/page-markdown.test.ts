import { describe, expect, it } from "vitest"

import { renderLlmsIndex, renderPageMarkdown } from "./page-markdown.ts"
import { siteUrl } from "./build-origins.ts"

describe("renderPageMarkdown", () => {
  it("puts the title once, the description as a quote, the source link, then the body", () => {
    expect(
      renderPageMarkdown({
        slug: "a/b",
        title: "Title",
        description: "Why.",
        body: "\nBody text\n\n",
      }),
    ).toBe(`# Title\n\n> Why.\n\nSource: ${siteUrl}/a/b\n\nBody text\n`)
  })

  it("omits the quote when the page has no description", () => {
    expect(renderPageMarkdown({ slug: "a", title: "T", body: "x" })).toBe(
      `# T\n\nSource: ${siteUrl}/a\n\nx\n`,
    )
  })
})

describe("renderLlmsIndex", () => {
  it("links each page's Markdown twin under its tab", () => {
    expect(
      renderLlmsIndex([
        {
          heading: "Guides",
          pages: [{ slug: "quickstart", title: "Quickstart", description: "Go." }],
        },
      ]),
    ).toContain(`## Guides\n- [Quickstart](${siteUrl}/quickstart.md): Go.`)
  })
})
