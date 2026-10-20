import { createSearchAPI } from "fumadocs-core/search/server"

import { generatedPages, publishedPages } from "../../content/source.ts"
import { products, productOf } from "../../content/navigation.ts"

export const dynamic = "force-static"

const productTitle = (slug: string): string | undefined =>
  products.find((product) => product.id === productOf(slug))?.title

/**
 * The static search index. It holds every published page and every generated page, tagged by
 * section, and the browser downloads it once when search first opens.
 */
export const { staticGET: GET } = createSearchAPI("advanced", {
  indexes: [
    ...generatedPages.map((page) => ({
      id: page.slug,
      title: page.title,
      description: page.description,
      url: `/${page.slug}`,
      tag: productTitle(page.slug),
      structuredData: {
        headings: [],
        contents: page.sections.flatMap((section) =>
          section.cards.map((card) => ({ heading: undefined, content: card.title })),
        ),
      },
    })),
    ...publishedPages.map(({ slug, page }) => ({
      id: page.url,
      title: page.data.title,
      description: page.data.description,
      url: page.url,
      tag: productTitle(slug),
      structuredData: page.data.structuredData,
    })),
  ],
})
