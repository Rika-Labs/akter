import { navigation, products, type Product } from "./navigation.ts"
import { iconOf, type IconName } from "./page-icons.ts"

/** How the sidebar names a page, and the line shown under it in lists. */
export type PageTitles = (slug: string) => {
  readonly title: string
  readonly description?: string | undefined
}

/** One link in the sidebar. */
export interface SidebarItem {
  readonly title: string
  readonly href: string
  readonly icon: IconName
}

/** A run of links under a heading; the first group of a section may have none. */
export interface SidebarGroup {
  readonly heading?: string | undefined
  readonly items: ReadonlyArray<SidebarItem>
}

/** What the sidebar shows while one section is selected. */
export interface Sidebar {
  readonly product: Product
  readonly groups: ReadonlyArray<SidebarGroup>
}

/** The pages the search palette lists before anything is typed, as sidebar addresses. */
export const suggestedHrefs: ReadonlyArray<string> = [
  "/quickstart",
  "/guides/concepts",
  "/cloud/get-started",
  "/api/01-server-api",
  "/api/06-cli",
]

const item = (slug: string, title: string): SidebarItem => ({
  title,
  href: `/${slug}`,
  icon: iconOf(slug),
})

/**
 * Builds the sidebar of every section straight from the navigation: a group per navigation
 * group, in order, with the section's home page first.
 */
export const buildSidebars = (titles: PageTitles): ReadonlyArray<Sidebar> =>
  products.map((product) => {
    const home = item(product.home.slice(1), product.homeTitle)
    const groups = navigation
      .filter((tab) => tab.product === product.id)
      .flatMap((tab) => tab.groups)
      .map((group): SidebarGroup => ({
        heading: group.group,
        items: [
          ...(group.group === product.homeGroup ? [home] : []),
          ...group.pages.map((slug) => item(slug, titles(slug).title)),
        ],
      }))

    return {
      product,
      groups: product.homeGroup === undefined ? [{ items: [home] }, ...groups] : groups,
    }
  })
