/**
 * The website's address, used for canonical links, the sitemap and Open Graph tags. It is a
 * placeholder until the production domain is chosen; every absolute URL derives from it.
 */
export const siteUrl = "https://akter.dev"

/** The repository the site links to for source, issues, the licence and the full benchmark report. */
export const githubUrl = "https://github.com/Rika-Labs/akter"

/**
 * Where the hosted console lives. The console is not deployed yet, so these are placeholders that
 * keep the Sign in and Start building links in one place.
 */
export const consoleUrl = "https://app.akter.dev"

/** The public documentation, hosted on Mintlify from the repository's `docs/` directory. */
export const docsUrl = "https://docs.akter.dev"

/** The documentation's first page, where a new developer starts. */
export const quickstartUrl = `${docsUrl}/quickstart`

/** Where "Talk to us" and the Enterprise plan point until a sales address exists. */
export const contactUrl = "mailto:hello@akter.dev"

/** The one sentence the product is described by everywhere it needs a description. */
export const headline =
  "The framework for durable, stateful backends that power realtime apps, background work, and agents."

/** The install command the marketing pages show; it must match the published alpha tag. */
export const installCommand = "bun add @rikalabs/akter@alpha"

/** A top-level destination in the header and footer. */
export interface Destination {
  readonly label: string
  readonly href: string
}

/** The header's page links, in order. */
export const pages: ReadonlyArray<Destination> = [
  { label: "Docs", href: docsUrl },
  { label: "Examples", href: "/examples" },
  { label: "Benchmarks", href: "/benchmarks" },
  { label: "Pricing", href: "/pricing" },
]

/** The repository file that holds the benchmark report the site's numbers come from. */
export const benchmarkReportUrl = `${githubUrl}/blob/main/BENCHMARKS.md`
