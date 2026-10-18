import type { MetadataRoute } from "next"

import { publishedSlugs } from "../content/navigation.ts"
import { pageUrl } from "../content/page-markdown.ts"
import { generatedPages } from "../content/source.ts"

export const dynamic = "force-static"

export default function sitemap(): MetadataRoute.Sitemap {
  return [...generatedPages.map((page) => page.slug), ...publishedSlugs].map((slug) => ({
    url: pageUrl(slug),
  }))
}
