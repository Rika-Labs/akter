import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { PageActions } from "../../../components/page-actions.tsx"
import { mdxComponents } from "../../../components/mdx-components.tsx"
import { Toc } from "../../../components/toc.tsx"
import { publishedSlugs } from "../../../content/navigation.ts"
import { pageUrl } from "../../../content/page-markdown.ts"
import { source } from "../../../content/source.ts"
import { tocItems } from "../../../content/toc-items.ts"

interface PageParams {
  readonly params: Promise<{ readonly slug: ReadonlyArray<string> }>
}

export const dynamicParams = false

export function generateStaticParams() {
  return publishedSlugs.map((slug) => ({ slug: slug.split("/") }))
}

export async function generateMetadata(props: PageParams): Promise<Metadata> {
  const { slug } = await props.params
  const page = source.getPage([...slug])

  if (page === undefined) notFound()

  const url = pageUrl(slug.join("/"))

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      url,
      title: page.data.title,
      description: page.data.description,
    },
  }
}

export default async function DocsPageRoute(props: PageParams) {
  const { slug } = await props.params
  const page = source.getPage([...slug])

  if (page === undefined) notFound()

  const Body = page.data.body
  const path = slug.join("/")

  return (
    <div className="ak-page-grid">
      <article className="ak-page" data-kind="doc">
        <header className="ak-head">
          <h1 className="ak-title">{page.data.title}</h1>
        </header>
        <div className="ak-prose">
          <Body components={mdxComponents} />
        </div>
        <div className="ak-page-actions-mobile">
          <PageActions slug={path} />
        </div>
      </article>
      <aside className="ak-toc-col">
        <div className="ak-page-rail">
          <Toc items={tocItems(page.data.toc, page.data.structuredData.headings)} />
          <PageActions slug={path} />
        </div>
      </aside>
    </div>
  )
}
