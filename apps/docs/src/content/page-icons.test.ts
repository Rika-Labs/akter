import { describe, expect, it } from "vitest"

import { products, publishedSlugs } from "./navigation.ts"
import { iconNames, iconOf, pageIcons, productIcons } from "./page-icons.ts"

const listed = [...publishedSlugs, "welcome", "api/overview"]

describe("page icons", () => {
  it("gives every published page and both generated pages an icon", () => {
    for (const slug of listed) expect(iconNames, slug).toContain(iconOf(slug))
  })

  it("names a page with no icon instead of drawing a blank", () => {
    expect(() => iconOf("not/a/page")).toThrow("No icon for not/a/page")
  })

  it("lists no icon that nothing uses, and no page that is not listed", () => {
    const used = new Set([...pageIcons.values(), ...Object.values(productIcons)])

    expect(iconNames.filter((name) => !used.has(name))).toEqual([])
    expect([...pageIcons.keys()].toSorted()).toEqual(listed.toSorted())
  })

  it("gives each section an icon", () => {
    expect(Object.keys(productIcons).toSorted()).toEqual(products.map((p) => p.id).toSorted())
  })
})
