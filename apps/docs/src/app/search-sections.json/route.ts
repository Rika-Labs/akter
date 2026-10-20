import { searchSections } from "../../content/search-sections.ts"
import { publishedPages } from "../../content/source.ts"

export const dynamic = "force-static"

/** The sections of every published page, which the search palette loads beside the index. */
export const GET = () =>
  Response.json(
    searchSections(
      publishedPages.map(({ page }) => ({
        url: page.url,
        toc: page.data.toc,
        structuredData: page.data.structuredData,
      })),
    ),
  )
