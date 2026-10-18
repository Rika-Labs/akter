import { publishedSlugs } from "../../content/navigation.ts"
import { pageBody } from "../../content/page-body.ts"
import { renderPageMarkdown } from "../../content/page-markdown.ts"
import { pageOf } from "../../content/source.ts"

export const dynamic = "force-static"

/** Every published page as Markdown in one file, in navigation order. */
export function GET() {
  const pages = publishedSlugs.map((slug) => {
    const { data } = pageOf(slug)

    return renderPageMarkdown({
      slug,
      title: data.title,
      description: data.description,
      body: pageBody(slug),
    })
  })

  return new Response(pages.join("\n---\n\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
