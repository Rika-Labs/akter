import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { navigation, publishedSlugs } from "./navigation.ts"
import { firstHeading, stripFrontmatter } from "./headings.ts"
import { docsDirectory, readRepositoryFile } from "./repository.ts"
import { welcomeSections } from "./welcome.ts"

describe("navigation", () => {
  it("lists three tabs in order and no page twice", () => {
    expect(navigation.map((tab) => tab.tab)).toEqual(["Guides", "Akter Cloud", "API reference"])
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
        /^(decisions|contracts|architecture|verification|vision|milestones|security)\//,
      )
  })

  it("only links welcome cards to published pages", () => {
    for (const card of welcomeSections.flatMap((section) => section.cards))
      expect(publishedSlugs, card.slug).toContain(card.slug)
  })
})
