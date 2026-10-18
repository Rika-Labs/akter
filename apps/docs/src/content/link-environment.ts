import { headingAnchors } from "./headings.ts"
import type { LinkEnvironment } from "./links.ts"
import { navigation, publishedSlugs } from "./navigation.ts"
import { pathKind, readRepositoryFile } from "./repository.ts"

const published = new Set(publishedSlugs)

const anchorCache = new Map<string, ReadonlySet<string>>()

/**
 * The real environment for link rewriting: every published page plus the welcome page is
 * a route, files are looked up in the repository checkout, and a page's anchors come from
 * its source Markdown.
 */
export const linkEnvironment: LinkEnvironment = {
  routes: new Set([...published, "welcome"]),
  kind: pathKind,
  anchors: (slug) => {
    if (!published.has(slug)) return undefined

    const cached = anchorCache.get(slug)

    if (cached !== undefined) return cached

    const anchors = headingAnchors(readRepositoryFile(`docs/${slug}.md`))

    anchorCache.set(slug, anchors)

    return anchors
  },
}

/** The tab a published slug belongs to, for the sidebar and sitemap. */
export const tabOf = (slug: string): string | undefined =>
  navigation.find((tab) => tab.groups.some((group) => group.pages.includes(slug)))?.tab
