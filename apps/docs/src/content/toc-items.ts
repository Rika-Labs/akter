/** One entry of a page's table of contents, as the page body produced it. */
export interface PageTocEntry {
  readonly url: string
  readonly depth: number
}

/** One heading of a page with the text it shows. */
export interface PageHeading {
  readonly id: string
  readonly content: string
}

/** One entry of the table of contents the browser draws: plain text, its anchor and its level. */
export interface TocItem {
  readonly title: string
  readonly id: string
  readonly depth: number
}

/**
 * The entries of a page's table of contents, titled by the plain text of their headings so
 * nothing but strings crosses to the browser. A heading with no recorded text shows its anchor.
 */
export const tocItems = (
  entries: ReadonlyArray<PageTocEntry>,
  headings: ReadonlyArray<PageHeading>,
): ReadonlyArray<TocItem> => {
  const titles = new Map(headings.map((heading) => [heading.id, heading.content]))

  return entries.map((entry) => {
    const id = entry.url.replace(/^#/, "")

    return { title: titles.get(id) ?? id, id, depth: entry.depth }
  })
}
