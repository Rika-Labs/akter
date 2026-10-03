import { posix } from "node:path"
import { githubUrl, siteUrl } from "../site.ts"

const EXTENSION = /\.md$/

const NUMBER_PREFIX = /^\d+-/

/**
 * The URL slug for a file under the repository's `docs/` directory, given its path relative to
 * `docs/` without the extension. Guides and product pages sit at the top of `/docs`, the API pages
 * keep their `api/` prefix, numeric file prefixes are dropped, and an API `README` is the overview.
 */
export const slugFor = (id: string): string => {
  const parts = id.replace(EXTENSION, "").split("/")
  const name = (parts.at(-1) ?? "").replace(NUMBER_PREFIX, "")

  if (parts[0] === "api") return `api/${name === "README" ? "overview" : name}`

  return name
}

/** The page URL for a slug; the quickstart is the documentation's home page. */
export const urlFor = (slug: string): string => (slug === "quickstart" ? "/docs" : `/docs/${slug}`)

/** The URL of a page's raw Markdown, for agents. */
export const markdownUrlFor = (slug: string): string => `/docs/${slug}.md`

/** Maps each source file (relative to `docs/`, with extension) to the slug of its page. */
export type PageTable = ReadonlyMap<string, string>

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/**
 * Resolves a link written in a repository document to where it should point on the site: a page
 * the site renders becomes its URL, anything else in the repository becomes a GitHub link, and
 * anchors and absolute URLs stay as they are. `from` is the linking file relative to `docs/`.
 * With `markdown`, in-site links point at the raw Markdown and carry the site's origin.
 */
export const resolveLink = (
  href: string,
  from: string,
  table: PageTable,
  markdown = false,
): string => {
  if (href.startsWith("#") || EXTERNAL.test(href)) return href

  const hashAt = href.indexOf("#")
  const target = hashAt === -1 ? href : href.slice(0, hashAt)
  const hash = hashAt === -1 ? "" : href.slice(hashAt)
  const inDocs = posix.normalize(posix.join(posix.dirname(from), target))
  const slug = table.get(inDocs)

  if (slug !== undefined)
    return markdown ? `${siteUrl}${markdownUrlFor(slug)}${hash}` : `${urlFor(slug)}${hash}`

  const inRepository = posix.normalize(posix.join("docs", posix.dirname(from), target))
  const kind = target.endsWith("/") || posix.extname(target) === "" ? "tree" : "blob"

  return `${githubUrl}/${kind}/main/${inRepository.replace(/\/$/, "")}${hash}`
}

const LINK = /\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g

/**
 * Rewrites every inline link in Markdown source with `resolveLink`, leaving fenced code untouched,
 * so a document served as raw Markdown has links that work away from the repository.
 */
export const rewriteLinks = (markdown: string, from: string, table: PageTable): string => {
  let fenced = false

  return markdown
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        fenced = !fenced
        return line
      }

      return fenced
        ? line
        : line.replace(
            LINK,
            (_, href: string, title: string) =>
              `](${resolveLink(href, from, table, true)}${title})`,
          )
    })
    .join("\n")
}

/** The prompt "Open in Claude" starts with, pointing the model at a page's raw Markdown. */
export const claudePrompt = (markdownUrl: string): string =>
  `Read ${markdownUrl} and answer my questions about Akter using only what it says.`
