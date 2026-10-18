import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/notebook/page"
import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { mdxComponents } from "../../../components/mdx-components.tsx"
import { PageActions } from "../../../components/page-actions.tsx"
import { publishedSlugs } from "../../../content/navigation.ts"
import { pageUrl } from "../../../content/page-markdown.ts"
import { source } from "../../../content/source.ts"

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

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <PageActions
        slug={slug.join("/")}
        pageUrl={pageUrl(slug.join("/"))}
        sourcePath={`docs/${slug.join("/")}.md`}
      />
      <DocsBody>
        <Body components={mdxComponents} />
      </DocsBody>
    </DocsPage>
  )
}
