import { publishedSlugs } from "../../../content/navigation.ts"
import { renderPageMarkdown } from "../../../content/page-markdown.ts"
import { pageBody } from "../../../content/page-body.ts"
import { pageOf } from "../../../content/source.ts"
import { renderWelcomeMarkdown } from "../../../content/welcome.ts"

export const dynamic = "force-static"

export const dynamicParams = false

export function generateStaticParams() {
  return [...publishedSlugs, "welcome"].map((slug) => ({ slug: slug.split("/") }))
}

const markdown = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } })

/** The Markdown twin of a page: `/<page>.md` serves what `/md/<page>` renders. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: ReadonlyArray<string> }> },
) {
  const slug = (await context.params).slug.join("/")

  if (slug === "welcome")
    return markdown(renderWelcomeMarkdown((card) => pageOf(card).data.description))

  const { data } = pageOf(slug)

  return markdown(
    renderPageMarkdown({
      slug,
      title: data.title,
      description: data.description,
      body: pageBody(slug),
    }),
  )
}
