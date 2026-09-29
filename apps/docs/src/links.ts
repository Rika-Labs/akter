import { Effect, Schema } from "effect"

import { pageBase } from "./pages.ts"

/** The GitHub repository the site links to for files it does not publish. */
export const repositoryUrl = "https://github.com/Rika-Labs/durable-actors"

/** GitHub resolves `blob/` to `tree/` for directories, so one prefix serves both. */
export const repositoryFileUrl = (path: string) => `${repositoryUrl}/blob/main/${path}`

/** An HTML page links to `.html` siblings; a Markdown copy links to `.md` siblings. */
export type LinkFormat = "html" | "md"

/**
 * A relative href that leaves the repository root: the source has a broken
 * link, and publishing it would hide the break.
 */
export class LinkOutsideRepository extends Schema.TaggedError<LinkOutsideRepository>()(
  "LinkOutsideRepository",
  { source: Schema.String, href: Schema.String },
) {}

/**
 * A synthetic origin lets the URL parser resolve `..` segments; a result
 * outside `/repo/` means the link climbed above the repository root.
 */
const repositoryRoot = "https://repository.invalid/repo/"

const hasScheme = /^[a-z][a-z0-9+.-]*:/i

const relativePath = (fromDir: ReadonlyArray<string>, to: string) => {
  const target = to.split("/")
  let shared = 0

  while (
    shared < fromDir.length &&
    shared < target.length - 1 &&
    fromDir[shared] === target[shared]
  )
    shared += 1

  const up = fromDir.slice(shared).map(() => "..")

  return [...up, ...target.slice(shared)].join("/")
}

/**
 * Rewrites a link found in the Markdown source at `docs/<source>`.
 *
 * Links to other published pages stay relative, so the site works from any
 * base path. Links to anything else in the repository, including contracts
 * and decisions, point at the file on GitHub. External links and in-page
 * anchors are unchanged.
 */
export const rewriteHref = (input: {
  readonly source: string
  readonly href: string
  readonly format: LinkFormat
  readonly published: ReadonlySet<string>
}) =>
  Effect.gen(function* () {
    const { source, href } = input

    if (href === "" || href.startsWith("#") || href.startsWith("//") || hasScheme.test(href))
      return href

    const resolved = new URL(href, `${repositoryRoot}docs/${source}`)

    if (!resolved.href.startsWith(repositoryRoot))
      return yield* LinkOutsideRepository.make({ source, href })

    const path = decodeURIComponent(
      resolved.pathname.slice(new URL(repositoryRoot).pathname.length),
    )

    const suffix = `${resolved.search}${resolved.hash}`

    const docsPath = path.startsWith("docs/") ? path.slice("docs/".length) : undefined

    if (docsPath === undefined || !input.published.has(docsPath))
      return `${repositoryFileUrl(path)}${suffix}`

    const fromDir = pageBase(source).split("/").slice(0, -1)

    return `${relativePath(fromDir, `${pageBase(docsPath)}.${input.format}`)}${suffix}`
  })
