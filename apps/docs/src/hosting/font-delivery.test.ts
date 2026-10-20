import { describe, expect, it } from "vitest"

import {
  dataUrls,
  fontPreloadProblems,
  fontPreloadTags,
  fontPreloads,
  withFontPreloads,
} from "./font-delivery.ts"

const inter = "/_next/static/media/Inter_latin.p.3kiq_9t_95gfe.woff2"
const mono = "/_next/static/media/GeistMono_latin.p.1m7tual43vbc3.woff2"

const link = (href: string, extra = 'type="font/woff2" crossorigin=""') =>
  `<link rel="preload" href="${href}" as="font" ${extra}/>`

const page = (head: string) =>
  `<html><head><title>T</title>${head}</head><body><link rel="preload" href="/x.woff2" as="font"/></body></html>`

describe("fontPreloads", () => {
  it("reads the preload links of the head whatever the order of their attributes", () => {
    expect(fontPreloads(page(link(inter) + link(mono)))).toEqual([
      { href: inter, type: "font/woff2", crossorigin: true },
      { href: mono, type: "font/woff2", crossorigin: true },
    ])
  })

  it("ignores stylesheets, script preloads and anything after the head", () => {
    const head = `<link rel="stylesheet" href="/a.css"/><link rel="preload" href="/a.js" as="script"/>${link(inter)}`

    expect(fontPreloads(page(head)).map((found) => found.href)).toEqual([inter])
  })
})

describe("fontPreloadProblems", () => {
  it("accepts both faces as hashed woff2 files in the anonymous cross-origin mode", () => {
    expect(fontPreloadProblems(page(link(inter) + link(mono)), 2)).toEqual([])
  })

  it("rejects a page that preloads fewer faces than the two it uses", () => {
    expect(fontPreloadProblems(page(link(inter)), 2)).toEqual(["has 1 font preloads, not 2"])
    expect(fontPreloadProblems(page(""), 2)).toEqual(["has 0 font preloads, not 2"])
  })

  it("rejects a preload without crossorigin, which the browser would fetch twice", () => {
    expect(fontPreloadProblems(page(link(inter, 'type="font/woff2"') + link(mono)), 2)).toEqual([
      `preloads ${inter} without crossorigin`,
    ])
  })

  it("rejects a preload without the woff2 type", () => {
    expect(fontPreloadProblems(page(link(inter, 'crossorigin=""') + link(mono)), 2)).toEqual([
      `preloads ${inter} without type font/woff2`,
    ])
  })

  it("rejects a font from another origin, a data URL, or a file whose name has no hash", () => {
    for (const href of [
      "https://fonts.example.com/inter-0a1b2c3d4e5f.woff2",
      "data:font/woff2;base64,d09GMg==",
      "/fonts/inter.woff2",
      "/_next/static/media/Inter_latin.p.woff2",
    ])
      expect(fontPreloadProblems(page(link(href) + link(mono)), 2)).toEqual([
        `preloads ${href}, which is not a hashed woff2 file of the export`,
      ])
  })
})

describe("withFontPreloads", () => {
  it("puts the links of another page at the end of a head that has none, once", () => {
    const tags = fontPreloadTags(page(link(inter) + link(mono)))
    const bare = page("")
    const fixed = withFontPreloads(bare, tags)

    expect(tags).toEqual([link(inter), link(mono)])
    expect(fontPreloadProblems(bare, 2)).toEqual(["has 0 font preloads, not 2"])
    expect(fontPreloadProblems(fixed, 2)).toEqual([])
    expect(fixed.indexOf(link(inter))).toBeLessThan(fixed.indexOf("</head>"))
    expect(fixed.split("</head>")).toHaveLength(2)
  })
})

describe("dataUrls", () => {
  it("finds a data URL in a stylesheet or a page, whatever it carries", () => {
    expect(
      dataUrls('a{src:url(data:font/woff2;base64,AAAA)}b{mask:url("data:image/svg+xml,%3Csvg")}'),
    ).toEqual(["data:font/woff2;", "data:image/svg+xml,"])
    expect(dataUrls('<img src="data:image/png;base64,iVBOR">')).toEqual(["data:image/png;"])
  })

  it("leaves ordinary text about data alone", () => {
    expect(dataUrls("the data: field, a `data:` key, user data:x and metadata:text")).toEqual([])
  })
})
