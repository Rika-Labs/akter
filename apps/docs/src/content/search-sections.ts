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
