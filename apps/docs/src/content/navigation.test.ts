import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { apiOverviewPage, welcomePage } from "./landing-pages.ts"
import { navigation, productOf, products, publishedSlugs } from "./navigation.ts"
import { firstHeading, stripFrontmatter } from "./headings.ts"
import { docsDirectory, readRepositoryFile } from "./repository.ts"

describe("navigation", () => {
  it("lists two tabs in order and no page twice", () => {
    expect(navigation.map((tab) => tab.tab)).toEqual(["Guides", "API reference"])
    expect(new Set(publishedSlugs).size).toBe(publishedSlugs.length)
  })

  it("lists only Markdown files that exist, each with a title from frontmatter or a heading", () => {
    for (const slug of publishedSlugs) {
      expect(existsSync(join(docsDirectory, `${slug}.md`)), slug).toBe(true)

      const source = readRepositoryFile(`docs/${slug}.md`)

      expect(
        /^title: ./m.test(source) || firstHeading(stripFrontmatter(source)) !== undefined,
        slug,
      ).toBe(true)
    }
  })

  it("never publishes a document that is internal by location", () => {
    for (const slug of publishedSlugs)
      expect(slug, slug).not.toMatch(
        /^(internals|decisions|contracts|architecture|verification|vision|milestones|security)\//,
      )
  })

  it("only links generated-page cards to published pages", () => {
    const pages = [welcomePage, apiOverviewPage((slug) => ({ title: slug }))]

    for (const card of pages.flatMap((page) => page.sections.flatMap((section) => section.cards)))
      expect(publishedSlugs, card.slug).toContain(card.slug)
  })

  it("puts every tab in one of the two sections and names each section's home page", () => {
    expect(products.map((product) => product.id)).toEqual(["documentation", "api-reference"])
    expect(navigation.map((tab) => tab.product)).toEqual(["documentation", "api-reference"])
    expect(products.map((product) => productOf(product.home.slice(1)))).toEqual(
      products.map((product) => product.id),
    )
  })

  it("assigns every published page to the section of its tab", () => {
    for (const tab of navigation)
      for (const group of tab.groups)
        for (const slug of group.pages) expect(productOf(slug), slug).toBe(tab.product)

    expect(productOf("not/a/page")).toBeUndefined()
  })
})
