import { navigation } from "../../content/navigation.ts"
import { renderLlmsIndex } from "../../content/page-markdown.ts"
import { pageOf } from "../../content/source.ts"

export const dynamic = "force-static"

/** The `llms.txt` index: every tab's pages with a link to each page's Markdown twin. */
export function GET() {
  return new Response(
    renderLlmsIndex(
      navigation.map((tab) => ({
        heading: tab.tab,
        pages: tab.groups.flatMap((group) =>
          group.pages.map((slug) => ({
            slug,
            title: pageOf(slug).data.title,
            description: pageOf(slug).data.description,
          })),
        ),
      })),
    ),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  )
}
