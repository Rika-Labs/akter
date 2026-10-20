import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { DocFrame } from "../../../components/doc-frame.tsx"
import { mdxComponents } from "../../../components/mdx-components.tsx"
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
    <DocFrame
      title={page.data.title}
      slug={path}
      toc={tocItems(page.data.toc, page.data.structuredData.headings)}
    >
      <Body components={mdxComponents} />
    </DocFrame>
  )
}
