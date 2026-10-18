/** One sidebar group: its heading and the page slugs under it, in reading order. */
export interface NavigationGroup {
  readonly group: string
  readonly pages: ReadonlyArray<string>
}

/** The two sections the sidebar switches between. */
export type ProductId = "documentation" | "api-reference"

/**
 * One section of the site: how the product switcher names it, and the page it opens. The
 * home page is not in the navigation; the sidebar lists it as `homeTitle` at the top of the
 * group named by `homeGroup`, or alone above the groups when there is none.
 */
export interface Product {
  readonly id: ProductId
  readonly title: string
  readonly description: string
  readonly home: string
  readonly homeTitle: string
  readonly homeGroup?: string
}

/** The sections in the order the product switcher lists them. */
export const products: ReadonlyArray<Product> = [
  {
    id: "documentation",
    title: "Documentation",
    description: "Guides and operations",
    home: "/welcome",
    homeTitle: "Welcome",
    homeGroup: "Get started",
  },
  {
    id: "api-reference",
    title: "API reference",
    description: "Runtime, client and CLI",
    home: "/api/overview",
    homeTitle: "API reference",
  },
]

/** One group of pages under a heading, listed in the section named by `product`. */
export interface NavigationTab {
  readonly tab: string
  readonly product: ProductId
  readonly groups: ReadonlyArray<NavigationGroup>
}

/**
 * The only list of published pages. A slug is the path of a Markdown file under the
 * repository's `docs/` directory without its extension, and is also the page's URL.
 */
export const navigation: ReadonlyArray<NavigationTab> = [
  {
    tab: "Guides",
    product: "documentation",
    groups: [
      {
        group: "Get started",
        pages: [
          "quickstart",
          "guides/concepts",
          "guides/actions-and-jobs",
          "product/fit-and-non-fit",
        ],
      },
      {
        group: "Guides",
        pages: ["guides/testing", "guides/deploy", "guides/comparison"],
      },
      {
        group: "Self-host operations",
        pages: [
          "operations/self-host",
          "operations/01-deployment",
          "operations/02-migrations",
          "operations/03-observability",
          "operations/04-backup-restore",
          "operations/support-matrix",
          "operations/runbooks",
          "operations/retention",
          "operations/alpha-upgrades",
          "operations/05-releasing",
        ],
      },
    ],
  },
  {
    tab: "Akter Cloud",
    product: "documentation",
    groups: [
      {
        group: "Akter Cloud",
        pages: [
          "cloud/get-started",
          "cloud/storage",
          "cloud/deploy",
          "cloud/environment-variables",
          "cloud/logs",
          "cloud/pricing-and-limits",
          "cloud/account-and-data",
        ],
      },
    ],
  },
  {
    tab: "API reference",
    product: "api-reference",
    groups: [
      {
        group: "Runtime",
        pages: [
          "api/01-server-api",
          "api/02-context",
          "api/03-typescript-sdk",
          "api/jobs",
          "api/lists-and-find",
          "api/forks",
        ],
      },
      {
        group: "Clients and CLI",
        pages: [
          "api/06-cli",
          "api/07-cloud-logs",
          "api/08-cloud-usage",
          "api/09-environment-api-keys",
          "api/generated-contracts",
        ],
      },
      {
        group: "Conventions",
        pages: ["api/naming", "api/versioning"],
      },
    ],
  },
]

const generatedPages: ReadonlyMap<string, ProductId> = new Map([
  ["welcome", "documentation"],
  ["api/overview", "api-reference"],
])

/** The section a page belongs to. The generated pages are not in the navigation, so they are named here. */
export const productOf = (slug: string): ProductId | undefined =>
  generatedPages.get(slug) ??
  navigation.find((tab) => tab.groups.some((group) => group.pages.includes(slug)))?.product

/** Every published slug in navigation order. */
export const publishedSlugs: ReadonlyArray<string> = navigation.flatMap((tab) =>
  tab.groups.flatMap((group) => group.pages),
)
