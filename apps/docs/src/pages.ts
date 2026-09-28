/** The site's sections, in sidebar and `llms.txt` order. */
export const sections = ["Start", "API reference"] as const

export type Section = (typeof sections)[number]

export interface Page {
  /** Path of the Markdown source, relative to `docs/`. */
  readonly source: string
  readonly section: Section
}

/** The page rendered as the site root. */
export const homeSource = "guides/README.md"

/**
 * Every page on the site, in reading order. Documents not listed here, such as
 * contracts and decisions, stay in the repository and are linked on GitHub.
 */
export const pages: ReadonlyArray<Page> = [
  { source: homeSource, section: "Start" },
  { source: "quickstart.md", section: "Start" },
  { source: "api/README.md", section: "API reference" },
  { source: "api/01-server-api.md", section: "API reference" },
  { source: "api/02-context.md", section: "API reference" },
  { source: "api/03-typescript-sdk.md", section: "API reference" },
  { source: "api/04-drizzle.md", section: "API reference" },
  { source: "api/05-generated-clients.md", section: "API reference" },
  { source: "api/generated-contracts.md", section: "API reference" },
  { source: "api/naming.md", section: "API reference" },
  { source: "api/versioning.md", section: "API reference" },
  { source: "api/post-foundation-sketches.md", section: "API reference" },
]

/** Repository documents the site links to instead of publishing. */
export const repositoryLinks: ReadonlyArray<{ readonly title: string; readonly path: string }> = [
  { title: "Runtime contracts", path: "docs/contracts/README.md" },
  { title: "Architecture decisions", path: "docs/decisions/README.md" },
  { title: "Architecture", path: "docs/architecture/README.md" },
  { title: "Verification", path: "docs/verification/README.md" },
  { title: "Operations", path: "docs/operations/README.md" },
]

/** Output path of a page without its extension: `api/02-context` or `index`. */
export const pageBase = (source: string) =>
  source === homeSource ? "index" : source.replace(/\.md$/, "")
