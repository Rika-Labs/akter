import { Effect } from "effect"

/**
 * Globs, relative to the repository root, of the Markdown documents whose
 * relative links and heading anchors must resolve. The docs site checks the
 * pages it publishes; this covers every other document, such as contracts,
 * decisions, vision, and package READMEs, which the site only links to.
 */
export const linkSources = [
  "README.md",
  "docs/**/*.md",
  "apps/*/README.md",
  "packages/*/README.md",
  "examples/*/README.md",
  "tooling/*/README.md",
  "infra/README.md",
] as const

const hasScheme = /^[a-z][a-z0-9+.-]*:/i

/** Every link destination in a Markdown document, as the renderer reads them. */
export const markdownLinks = (markdown: string) => {
  const hrefs: Array<string> = []

  Bun.markdown.render(markdown, {
    link: (children, meta) => {
      hrefs.push(meta.href)

      return children
    },
  })

  return hrefs
}

/** The heading ids of a Markdown document, generated as the docs site and GitHub generate them. */
export const headingAnchors = (markdown: string) =>
  new Set(
    [...Bun.markdown.html(markdown, { headings: { ids: true } }).matchAll(/ id="([^"]*)"/g)].map(
      (match) => match[1] ?? "",
    ),
  )

/** A relative link from `source` that names no file, or an anchor its target lacks. */
export interface BrokenLink {
  readonly source: string
  readonly href: string
  readonly reason: "outside the repository" | "no such file" | "no such heading"
}

/**
 * Checks the relative links of one document. `read` returns a repository
 * path's Markdown, `""` for an existing file that is not Markdown or a
 * directory, and `undefined` for a path that does not exist. External links
 * are not fetched.
 */
export const brokenLinks = Effect.fnUntraced(function* <E, R>(input: {
  readonly source: string
  readonly markdown: string
  readonly read: (path: string) => Effect.Effect<string | undefined, E, R>
}) {
  const broken: Array<BrokenLink> = []
  const root = "https://repository.invalid/repo/"

  for (const href of markdownLinks(input.markdown)) {
    if (href === "" || href.startsWith("//") || hasScheme.test(href)) continue

    const url = new URL(href, `${root}${input.source}`)

    if (!url.href.startsWith(root)) {
      broken.push({ source: input.source, href, reason: "outside the repository" })
      continue
    }

    const path = decodeURIComponent(url.pathname.slice(new URL(root).pathname.length))

    const target = href.startsWith("#")
      ? input.markdown
      : yield* input.read(path.replace(/\/$/, ""))

    if (target === undefined) broken.push({ source: input.source, href, reason: "no such file" })
    else if (
      url.hash !== "" &&
      path.endsWith(".md") &&
      !headingAnchors(target).has(decodeURIComponent(url.hash.slice(1)))
    )
      broken.push({ source: input.source, href, reason: "no such heading" })
  }

  return broken
})
