import type { ProductId } from "./navigation.ts"

/** The sidebar and card icons. Each name is a key of the icon table the components draw from. */
export const iconNames = [
  "activity",
  "archive",
  "arrow-right-left",
  "book-open",
  "boxes",
  "braces",
  "chart-column",
  "circle-arrow-up",
  "clipboard-list",
  "cloud",
  "cloud-upload",
  "columns-2",
  "database",
  "database-backup",
  "file-code",
  "file-json",
  "flask-conical",
  "gauge",
  "git-branch",
  "git-fork",
  "key-round",
  "layers",
  "layout-grid",
  "list-checks",
  "list-filter",
  "list-todo",
  "package",
  "rocket",
  "scroll-text",
  "send",
  "server",
  "square-code",
  "tag",
  "terminal",
  "type",
  "user-round",
  "variable",
  "workflow",
  "zap",
] as const

export type IconName = (typeof iconNames)[number]

const iconBySlug = {
  welcome: "rocket",
  "api/overview": "square-code",
  quickstart: "zap",
  "guides/concepts": "boxes",
  "guides/actions-and-jobs": "workflow",
  "product/fit-and-non-fit": "list-checks",
  "guides/testing": "flask-conical",
  "guides/deploy": "cloud-upload",
  "guides/comparison": "columns-2",
  "operations/self-host": "server",
  "operations/01-deployment": "package",
  "operations/02-migrations": "arrow-right-left",
  "operations/03-observability": "activity",
  "operations/04-backup-restore": "database-backup",
  "operations/support-matrix": "layout-grid",
  "operations/runbooks": "clipboard-list",
  "operations/retention": "archive",
  "operations/alpha-upgrades": "circle-arrow-up",
  "operations/05-releasing": "tag",
  "cloud/get-started": "cloud",
  "cloud/storage": "database",
  "cloud/deploy": "send",
  "cloud/environment-variables": "variable",
  "cloud/logs": "scroll-text",
  "cloud/pricing-and-limits": "gauge",
  "cloud/account-and-data": "user-round",
  "api/01-server-api": "braces",
  "api/02-context": "layers",
  "api/03-typescript-sdk": "file-code",
  "api/jobs": "list-todo",
  "api/lists-and-find": "list-filter",
  "api/forks": "git-fork",
  "api/06-cli": "terminal",
  "api/07-cloud-logs": "scroll-text",
  "api/08-cloud-usage": "chart-column",
  "api/09-environment-api-keys": "key-round",
  "api/generated-contracts": "file-json",
  "api/naming": "type",
  "api/versioning": "git-branch",
} as const satisfies Readonly<Record<string, IconName>>

/** The icon of every page a sidebar or card lists, by slug. The generated pages are named here too. */
export const pageIcons: ReadonlyMap<string, IconName> = new Map(Object.entries(iconBySlug))

/** The icon of a page, which every listed page must have. */
export const iconOf = (slug: string): IconName => {
  const icon = pageIcons.get(slug)

  if (icon === undefined) throw new Error(`No icon for ${slug}; add it to pageIcons`)

  return icon
}

/** The icon on a product's tile in the switcher. */
export const productIcons: Readonly<Record<ProductId, IconName>> = {
  documentation: "book-open",
  "api-reference": "square-code",
}
