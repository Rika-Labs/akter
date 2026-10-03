import { getCollection } from "astro:content"
import { githubUrl, siteUrl } from "../site.ts"
import { fallbackGroup, groups } from "./navigation.ts"
import { markdownUrlFor, resolveLink, rewriteLinks, slugFor, urlFor } from "./paths.ts"
import { firstParagraph } from "./markdown.ts"
import { proseClasses } from "./prose-classes.ts"
import { assemble, prepare } from "./prepare.ts"
import type { Outline, Section } from "./render-html.ts"
import { renderHtml } from "./render-html.ts"

/** One documentation page, rendered from a Markdown file in the repository's `docs/` directory. */
export interface DocPage {
  readonly id: string
  readonly slug: string
  readonly url: string
  readonly markdownUrl: string
  readonly sourceUrl: string
  readonly label: string
  readonly group: string
  readonly title: string
  readonly description: string
  readonly lead: string
  readonly html: string
  readonly outline: ReadonlyArray<Outline>
  readonly sections: ReadonlyArray<Section>
  readonly markdown: string
}

/** A sidebar group with its pages. */
export interface Sidebar {
  readonly title: string
  readonly pages: ReadonlyArray<DocPage>
}

/** The whole documentation set, in sidebar order. */
export interface Docs {
  readonly pages: ReadonlyArray<DocPage>
  readonly sidebar: ReadonlyArray<Sidebar>
}

const relativeToDocs = (path: string): string => path.slice(path.indexOf("docs/") + "docs/".length)

const sentence = (text: string): string => {
  const plain = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "")
  const end = plain.search(/[.!?](\s|$)/)

  return (end === -1 ? plain : plain.slice(0, end + 1)).slice(0, 200)
}

const stripParagraph = (html: string): string => html.replace(/^<p[^>]*>/, "").replace(/<\/p>$/, "")

const build = async (): Promise<Docs> => {
  const entries = (await getCollection("docs")).map((entry) => {
    if (entry.filePath === undefined || entry.body === undefined)
      throw new Error(`Documentation entry "${entry.id}" has no source file`)

    return { id: relativeToDocs(entry.filePath), source: entry.body }
  })
  const table = new Map(entries.map((entry) => [entry.id, slugFor(entry.id)]))
  const listed = new Map(
    groups.flatMap((group) =>
      group.entries.map((entry) => [entry.id, { group: group.title, label: entry.label }] as const),
    ),
  )

  const pages = await Promise.all(
    entries.map(async ({ id, source }): Promise<DocPage> => {
      const prepared = prepare(source)
      const slug = slugFor(id)
      const resolve = (href: string): string => resolveLink(href, id, table)
      const body = await renderHtml(prepared.body, resolve, proseClasses)
      const lead =
        prepared.intro === ""
          ? ""
          : stripParagraph((await renderHtml(prepared.intro, resolve, proseClasses)).html)
      const entry = listed.get(id)

      return {
        id,
        slug,
        url: urlFor(slug),
        markdownUrl: markdownUrlFor(slug),
        sourceUrl: `${githubUrl}/blob/main/docs/${id}`,
        label: entry?.label ?? prepared.title,
        group: entry?.group ?? fallbackGroup(id),
        title: prepared.title,
        description: sentence(
          prepared.intro === ""
            ? (firstParagraph(prepared.body) ?? prepared.title)
            : prepared.intro,
        ),
        lead,
        html: body.html,
        outline: body.outline,
        sections: body.sections,
        markdown: rewriteLinks(assemble(prepared), id, table),
      }
    }),
  )

  const byId = new Map(pages.map((page) => [page.id, page]))
  const order = groups.flatMap((group) => group.entries.map((entry) => entry.id))
  const missing = order.filter((id) => !byId.has(id))

  if (missing.length > 0)
    throw new Error(`The sidebar lists documents that do not exist: ${missing.join(", ")}`)

  const unlisted = pages.filter((page) => !listed.has(page.id))
  const sidebar = groups.map((group): Sidebar => ({
    title: group.title,
    pages: [
      ...group.entries.flatMap((entry) => byId.get(entry.id) ?? []),
      ...unlisted.filter((page) => page.group === group.title),
    ],
  }))

  return { pages: sidebar.flatMap((group) => group.pages), sidebar }
}

let docs: Promise<Docs> | undefined

/** Loads and renders every documentation page once per build. */
export const loadDocs = (): Promise<Docs> => {
  docs ??= build()
  return docs
}

/** The page after `page` in sidebar order, or `undefined` for the last one. */
export const nextPage = (all: ReadonlyArray<DocPage>, page: DocPage): DocPage | undefined =>
  all[all.indexOf(page) + 1]

/** The absolute URL of a page's raw Markdown, which the "Open in Claude" prompt points at. */
export const absoluteMarkdownUrl = (page: DocPage): string => `${siteUrl}${page.markdownUrl}`
