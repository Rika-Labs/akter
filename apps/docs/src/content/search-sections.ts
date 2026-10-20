import { z } from "zod"

import type { PageHeading, PageTocEntry } from "./toc-items.ts"

/** One section of a page as the search palette shows it. */
export interface SearchSection {
  readonly title: string
  readonly parent?: string | undefined
  readonly text?: string | undefined
}

/** What the sections of one page are read from: its address, outline and indexed text. */
export interface SearchablePage {
  readonly url: string
  readonly toc: ReadonlyArray<PageTocEntry>
  readonly structuredData: {
    readonly headings: ReadonlyArray<PageHeading>
    readonly contents: ReadonlyArray<{
      readonly heading?: string | undefined
      readonly content: string
    }>
  }
}

/**
 * Every section of every page by its address: the heading, the heading above it in the
 * outline, and the first paragraph beneath it. A result for a heading or for a paragraph can
 * then name its section and show the line under it, which the search index does not keep.
 */
export const searchSections = (
  pages: ReadonlyArray<SearchablePage>,
): Record<string, SearchSection> =>
  Object.fromEntries(
    pages.flatMap((page) => {
      const parents = new Map<string, string>()
      const above: Array<{ readonly depth: number; readonly title: string }> = []
      const titles = new Map(
        page.structuredData.headings.map((heading) => [heading.id, heading.content]),
      )

      for (const entry of page.toc) {
        const id = entry.url.replace(/^#/, "")
        const title = titles.get(id) ?? id

        while ((above.at(-1)?.depth ?? 0) >= entry.depth) above.pop()

        const parent = above.at(-1)

        if (parent !== undefined) parents.set(id, parent.title)

        above.push({ depth: entry.depth, title })
      }

      return page.structuredData.headings.map((heading): [string, SearchSection] => [
        `${page.url}#${heading.id}`,
        {
          title: heading.content,
          parent: parents.get(heading.id),
          text: page.structuredData.contents.find((part) => part.heading === heading.id)?.content,
        },
      ])
    }),
  )

z.config({ jitless: true })

const SectionsFile = z.record(z.string(), z.unknown())

const Section = z.object({
  title: z.string(),
  parent: z.string().optional().catch(undefined),
  text: z.string().optional().catch(undefined),
})

/**
 * The sections file as the palette uses it: fetched from the page's own origin and read as a
 * map by address. The file is data from the network, so a file that is missing, is not JSON, is
 * not a map (a null, a list, a string) or holds an entry without a title gives no sections for
 * that file or that entry, and the palette shows plain rows for it instead of failing on a
 * property of nothing. The result is a `Map`, so an address such as `__proto__` is only a key.
 * Zod is set to read objects without compiling a parser, because compiling one asks the engine
 * to build a function from a string, which the site's policy refuses and the browser reports as
 * a violation on every page that opens the palette.
 */
export const loadSearchSections = (
  request: (address: string) => Promise<Pick<Response, "ok" | "json">>,
): Promise<ReadonlyMap<string, SearchSection>> =>
  request("/search-sections.json")
    .then((response) => (response.ok ? response.json() : null))
    .then((body): ReadonlyMap<string, SearchSection> => {
      const file = SectionsFile.safeParse(body)

      if (!file.success) return new Map()

      return new Map(
        Object.entries(file.data).flatMap(
          ([address, entry]): ReadonlyArray<[string, SearchSection]> => {
            const section = Section.safeParse(entry)

            return section.success ? [[address, section.data]] : []
          },
        ),
      )
    })
    .catch(() => new Map())
