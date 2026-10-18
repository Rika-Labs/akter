import { describe, expect, it } from "vitest"

import { navigation } from "./navigation.ts"
import { buildPageTree } from "./page-tree.ts"

const tree = buildPageTree((slug) => ({ title: `T:${slug}` }))

describe("buildPageTree", () => {
  it("makes one root folder per tab, in navigation order", () => {
    expect(
      tree.children.map((node) => (node.type === "folder" ? [node.name, node.root] : node.type)),
    ).toEqual(navigation.map((tab) => [tab.tab, true]))
  })

  it("gives every tab folder its own id so the layout can tell the tabs apart", () => {
    const ids = tree.children.map((node) => (node.type === "folder" ? node.$id : undefined))

    expect(new Set(ids).size).toBe(navigation.length)
    expect(ids).not.toContain(undefined)
  })

  it("starts the first tab with its heading and the welcome page, then the listed pages in order", () => {
    const [guides] = tree.children

    expect(guides?.type === "folder" && guides.children.slice(0, 4)).toEqual([
      { type: "separator", name: "Get started" },
      { type: "page", name: "Welcome", url: "/welcome" },
      { type: "page", name: "T:quickstart", url: "/quickstart" },
      { type: "page", name: "T:guides/concepts", url: "/guides/concepts" },
    ])
  })

  it("lists every published page once, under the tab navigation puts it in", () => {
    for (const [index, tab] of navigation.entries()) {
      const folder = tree.children[index]
      const urls =
        folder?.type === "folder"
          ? folder.children.flatMap((node) => (node.type === "page" ? [node.url] : []))
          : []

      expect(urls.filter((url) => url !== "/welcome")).toEqual(
        tab.groups.flatMap((group) => group.pages.map((slug) => `/${slug}`)),
      )
    }
  })
})
