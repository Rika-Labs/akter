import type { Folder, Item, Root, Separator } from "fumadocs-core/page-tree"

import { navigation } from "./navigation.ts"

/** How the sidebar names a page, and the line shown under it in lists. */
export type PageTitles = (slug: string) => {
  readonly title: string
  readonly description?: string | undefined
}

/** The sidebar entry for the app-owned welcome page. */
export const welcomeUrl = "/welcome"

const pageItem = (slug: string, titles: PageTitles): Item => ({
  type: "page",
  name: titles(slug).title,
  url: `/${slug}`,
})

/**
 * Builds the page tree straight from the navigation: one root folder per tab so the layout
 * shows tabs, a separator per group so the sidebar shows its headings, and the welcome page
 * first in the first tab.
 */
export const buildPageTree = (titles: PageTitles): Root => ({
  name: "Akter docs",
  children: navigation.map((tab, tabIndex): Folder => {
    const children = tab.groups.flatMap((group, groupIndex): ReadonlyArray<Item | Separator> => [
      { type: "separator", name: group.group },
      ...(tabIndex === 0 && groupIndex === 0
        ? [{ type: "page", name: "Welcome", url: welcomeUrl } satisfies Item]
        : []),
      ...group.pages.map((slug) => pageItem(slug, titles)),
    ])

    return {
      type: "folder",
      $id: `tab:${tab.tab}`,
      name: tab.tab,
      root: true,
      children: [...children],
    }
  }),
})
