import { describe, expect, it } from "vitest"

import { navigation, products, publishedSlugs } from "./navigation.ts"
import { buildSidebars } from "./sidebar.ts"

const sidebars = buildSidebars((slug) => ({ title: "T:" + slug }))

const hrefsOf = (index: number) =>
  sidebars[index]?.groups.flatMap((group) => group.items.map((item) => item.href)) ?? []

describe("buildSidebars", () => {
  it("makes one sidebar per section, in the order the switcher lists them", () => {
    expect(sidebars.map((sidebar) => sidebar.product.id)).toEqual(products.map((p) => p.id))
  })

  it("starts the documentation sidebar with its first heading and the welcome page", () => {
    const [documentation] = sidebars
    const first = documentation?.groups[0]

    expect(first?.heading).toBe("Get started")
    expect(first?.items.slice(0, 2).map((item) => [item.title, item.href])).toEqual([
      ["Welcome", "/welcome"],
      ["T:quickstart", "/quickstart"],
    ])
  })

  it("starts the API reference sidebar with its overview, above the groups", () => {
    const [, api] = sidebars

    expect(api?.groups[0]).toEqual({
      items: [{ title: "API reference", href: "/api/overview", icon: "square-code" }],
    })
    expect(api?.groups.slice(1).map((group) => group.heading)).toEqual([
      "Runtime",
      "Clients and CLI",
      "Conventions",
    ])
  })

  it("lists every published page once, in navigation order, under the section of its tab", () => {
    const listed = [...hrefsOf(0), ...hrefsOf(1)].filter(
      (href) => href !== "/welcome" && href !== "/api/overview",
    )

    expect(listed.toSorted()).toEqual(publishedSlugs.map((slug) => "/" + slug).toSorted())

    for (const [index, product] of products.entries())
      expect(
        hrefsOf(index).filter((href) => href !== product.home),
        product.id,
      ).toEqual(
        navigation
          .filter((tab) => tab.product === product.id)
          .flatMap((tab) => tab.groups.flatMap((group) => group.pages.map((slug) => "/" + slug))),
      )
  })
})
