import { loader } from "fumadocs-core/source"
import type { Root } from "fumadocs-core/page-tree"

import { docs } from "../../.source/server"
import { publishedSlugs } from "./navigation.ts"
import { buildPageTree, type PageTitles } from "./page-tree.ts"

/** The published pages, served from the site root so a page's URL is its repository path. */
export const source = loader({ baseUrl: "/", source: docs.toFumadocsSource() })

/**
 * The page behind a slug. A navigation entry with no Markdown file fails the build here
 * instead of publishing a dead sidebar link.
 */
export const pageOf = (slug: string) => {
  const page = source.getPage(slug.split("/"))

  if (page === undefined)
    throw new Error(`docs/${slug}.md is listed in the navigation but was not built`)

  return page
}

const titles: PageTitles = (slug) => {
  const { data } = pageOf(slug)

  return { title: data.sidebarTitle ?? data.title, description: data.description }
}

/** The sidebar tree, one root folder per tab, built from the navigation. */
export const pageTree: Root = buildPageTree(titles)

/** Every published page, in navigation order. */
export const publishedPages = publishedSlugs.map((slug) => ({ slug, page: pageOf(slug) }))
