import type { ProductId } from "./navigation.ts"

/** The sidebar and card icons. Each name is a key of the icon table the components draw from. */
export const iconNames = [
  "activity",
  "arrow-right-left",
  "aws",
  "book-open",
  "boxes",
  "braces",
  "clipboard-list",
  "cloud-upload",
  "cloudflare",
  "file-code",
  "flask-conical",
  "fly",
  "gauge",
  "google-cloud",
  "hetzner",
  "key-round",
  "kubernetes",
  "layers",
  "layout-grid",
  "list-checks",
  "list-filter",
  "list-todo",
  "railway",
  "rocket",
  "send",
  "server",
  "square-code",
  "terminal",
  "zap",
] as const

export type IconName = (typeof iconNames)[number]

const iconBySlug = {
  welcome: "rocket",
  "api/overview": "square-code",
  "getting-started": "zap",
  "why-akter": "list-checks",
  "core/actors": "boxes",
  "core/commands": "send",
  "core/jobs": "list-todo",
  "core/lists": "layers",
  "core/realtime": "activity",
  "core/access": "key-round",
  "core/find": "list-filter",
  "guides/client": "file-code",
  "guides/testing": "flask-conical",
  "guides/operating": "gauge",
  "guides/changing-state": "arrow-right-left",
  "deploy/overview": "cloud-upload",
  "deploy/cloudflare": "cloudflare",
  "deploy/aws": "aws",
  "deploy/google-cloud": "google-cloud",
  "deploy/fly": "fly",
  "deploy/railway": "railway",
  "deploy/hetzner": "hetzner",
  "deploy/kubernetes": "kubernetes",
  "deploy/docker": "server",
  "reference/server": "braces",
  "reference/cli": "terminal",
  "reference/errors": "clipboard-list",
  "reference/guarantees": "layout-grid",
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
