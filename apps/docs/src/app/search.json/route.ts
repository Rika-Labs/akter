import { createSearchAPI } from "fumadocs-core/search/server"

import { tabOf } from "../../content/link-environment.ts"
import { publishedPages } from "../../content/source.ts"
import { welcomeDescription, welcomeSections, welcomeTitle } from "../../content/welcome.ts"

export const dynamic = "force-static"

/**
 * The static search index. It holds every published page and the welcome page, tagged by
 * tab, and the browser downloads it once when search first opens.
 */
export const { staticGET: GET } = createSearchAPI("advanced", {
  indexes: [
    {
      id: "welcome",
      title: welcomeTitle,
      description: welcomeDescription,
      url: "/welcome",
      structuredData: {
        headings: [],
        contents: welcomeSections.flatMap((section) =>
          section.cards.map((card) => ({ heading: undefined, content: card.title })),
        ),
      },
    },
    ...publishedPages.map(({ slug, page }) => ({
      id: page.url,
      title: page.data.title,
      description: page.data.description,
      url: page.url,
      tag: tabOf(slug),
      structuredData: page.data.structuredData,
    })),
  ],
})
