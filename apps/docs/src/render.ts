import { Effect, Schema } from "effect"

import { type LinkFormat, repositoryFileUrl, rewriteHref } from "./links.ts"
import { pageBase, repositoryLinks, type Section, sections } from "./pages.ts"

export interface SitePage {
  readonly source: string
  readonly section: Section
  readonly title: string
  /** The document's `**Responsibility:**` line, used for meta descriptions and `llms.txt`. */
  readonly summary: string
  readonly markdown: string
}

/** A published page must open with a `# ` title and a `**Responsibility:**` line. */
export class PageHeaderMissing extends Schema.TaggedError<PageHeaderMissing>()(
  "PageHeaderMissing",
  { source: Schema.String, field: Schema.Literals(["title", "responsibility"]) },
) {}

const markdownOptions = { headings: { ids: true } } as const

const inlineMarkdown = /[`*_]|\[([^\]]*)\]\([^)]*\)/g

const plainText = (markdown: string) =>
  markdown.replace(inlineMarkdown, (_match, label: string | undefined) => label ?? "").trim()

/**
 * Reads the title and summary every published document declares in its
 * header: the first line is the `# ` title and the next non-blank line is the
 * `**Responsibility:**` line. A later H1 or responsibility line, such as one in
 * a code example, does not count.
 */
export const readHeader = (input: { readonly source: string; readonly markdown: string }) =>
  Effect.gen(function* () {
    const [first = "", ...rest] = input.markdown.split("\n")

    const title = /^# (.+)$/.exec(first)?.[1]

    if (title === undefined)
      return yield* PageHeaderMissing.make({ source: input.source, field: "title" })

    const headerLine = rest.find((line) => line.trim() !== "") ?? ""

    const summary = /^\*\*Responsibility:\*\*(.+)$/.exec(headerLine)?.[1]

    if (summary === undefined)
      return yield* PageHeaderMissing.make({ source: input.source, field: "responsibility" })

    return { title: plainText(title), summary: plainText(summary) }
  })

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const linkHrefs = (markdown: string) => {
  const hrefs = new Set<string>()

  Bun.markdown.render(markdown, {
    link: (children, meta) => {
      hrefs.add(meta.href)

      return children
    },
  })

  return hrefs
}

/** Rewrites each distinct href once, so the text substitutions below stay synchronous. */
const rewrites = (
  page: SitePage,
  hrefs: Iterable<string>,
  format: LinkFormat,
  published: ReadonlySet<string>,
) =>
  Effect.forEach(new Set(hrefs), (href) =>
    rewriteHref({ source: page.source, href, format, published }).pipe(
      Effect.map((target) => [href, target] as const),
    ),
  ).pipe(Effect.map((entries) => new Map(entries)))

// Every Markdown form a link target can take; replacing only these keeps
// matching text in prose and code blocks untouched.
const linkDelimiters = [
  ["](", ")"],
  ["](", " "],
  ["](<", ">"],
  ["]: ", "\n"],
  ["]: ", " "],
] as const

/**
 * The page's Markdown with its links rewritten for the site: published pages
 * point at their `.md` copies and everything else in the repository at GitHub.
 */
export const renderMarkdownCopy = (input: {
  readonly page: SitePage
  readonly published: ReadonlySet<string>
}) =>
  Effect.gen(function* () {
    const targets = yield* rewrites(
      input.page,
      linkHrefs(input.page.markdown),
      "md",
      input.published,
    )

    let markdown = input.page.markdown

    for (const [href, target] of targets) {
      if (target === href) continue

      for (const [before, after] of linkDelimiters)
        markdown = markdown.replaceAll(`${before}${href}${after}`, `${before}${target}${after}`)
    }

    return markdown
  })

const htmlAttribute = / (href|src)="([^"]*)"/g

const renderBody = (page: SitePage, published: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const html = Bun.markdown.html(page.markdown, markdownOptions)

    const hrefs = [...html.matchAll(htmlAttribute)].map((match) =>
      (match[2] ?? "").replaceAll("&amp;", "&"),
    )

    const targets = yield* rewrites(page, hrefs, "html", published)

    return html.replace(htmlAttribute, (_match, name: string, value: string) => {
      const href = value.replaceAll("&amp;", "&")

      return ` ${name}="${escapeHtml(targets.get(href) ?? href)}"`
    })
  })

const relativeRoot = (source: string) => "../".repeat(pageBase(source).split("/").length - 1)

const sidebar = (current: SitePage, site: ReadonlyArray<SitePage>) => {
  const root = relativeRoot(current.source)

  const groups = sections.map((section) => {
    const items = site.flatMap((page) => {
      if (page.section !== section) return []

      const currentAttribute = page.source === current.source ? ' aria-current="page"' : ""

      return [
        `<li><a href="${root}${pageBase(page.source)}.html"${currentAttribute}>${escapeHtml(page.title)}</a></li>`,
      ]
    })

    return `<h2>${escapeHtml(section)}</h2><ul>${items.join("")}</ul>`
  })

  const repository = repositoryLinks
    .map(
      (link) => `<li><a href="${repositoryFileUrl(link.path)}">${escapeHtml(link.title)}</a></li>`,
    )
    .join("")

  return `${groups.join("")}<h2>In the repository</h2><ul>${repository}</ul>`
}

/** The complete HTML document for one page of `site`. */
export const renderHtmlPage = (input: {
  readonly page: SitePage
  readonly site: ReadonlyArray<SitePage>
}) =>
  Effect.gen(function* () {
    const { page, site } = input

    const body = yield* renderBody(page, new Set(site.map((entry) => entry.source)))

    const root = relativeRoot(page.source)

    const name = pageBase(page.source).split("/").at(-1) ?? "index"

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)} · Durable Actors</title>
<meta name="description" content="${escapeHtml(page.summary)}">
<link rel="stylesheet" href="${root}styles.css">
<link rel="alternate" type="text/markdown" href="${name}.md">
</head>
<body>
<header class="masthead">
<a class="brand" href="${root}index.html">Durable Actors</a>
<nav aria-label="Site">
<a href="${root}llms.txt">llms.txt</a>
<a href="https://github.com/Rika-Labs/durable-actors">GitHub</a>
</nav>
</header>
<div class="layout">
<nav class="sidebar" aria-label="Documentation">${sidebar(page, site)}</nav>
<main>
<article class="doc">
${body}
</article>
<footer class="page-footer">
<a href="${name}.md">View as Markdown</a>
<a href="${repositoryFileUrl(`docs/${page.source}`)}">Source on GitHub</a>
</footer>
</main>
</div>
</body>
</html>
`
  })
