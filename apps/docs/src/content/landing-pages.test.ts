import { describe, expect, it } from "vitest"

import {
  apiOverviewPage,
  landingPages,
  renderLandingMarkdown,
  welcomePage,
} from "./landing-pages.ts"
import { navigation } from "./navigation.ts"

const titles = (slug: string) => ({ title: "T:" + slug })

describe("apiOverviewPage", () => {
  it("has one section per API group, in navigation order, each card titled by its page", () => {
    const page = apiOverviewPage(titles)
    const groups = navigation
      .filter((tab) => tab.product === "api-reference")
      .flatMap((tab) => tab.groups)

    expect(page.sections.map((section) => section.heading)).toEqual(groups.map((g) => g.group))
    expect(page.sections.flatMap((section) => section.cards)).toEqual(
      groups.flatMap((group) => group.pages.map((slug) => ({ title: "T:" + slug, slug }))),
    )
  })
})

describe("landingPages", () => {
  it("lists the welcome page, then the API overview", () => {
    expect(landingPages(titles).map((page) => page.slug)).toEqual(["welcome", "api/overview"])
  })
})

describe("renderLandingMarkdown", () => {
  it("writes the title, the description, a link back and every card as a link to its twin", () => {
    const markdown = renderLandingMarkdown(welcomePage, (slug) =>
      slug === "quickstart" ? "Run your first actor." : undefined,
    )

    expect(markdown.startsWith("# Welcome to Akter\n\n> ")).toBe(true)
    expect(markdown).toContain("/welcome\n\n## Start here\n- [Quickstart](")
    expect(markdown).toContain("/quickstart.md): Run your first actor.\n")
    expect(markdown).toContain("- [Akter Cloud](")
    expect(markdown).not.toContain("undefined")
  })
})
