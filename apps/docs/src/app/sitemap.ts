import type { MetadataRoute } from "next"

import { publishedSlugs } from "../content/navigation.ts"
import { pageUrl } from "../content/page-markdown.ts"

export const dynamic = "force-static"

export default function sitemap(): MetadataRoute.Sitemap {
  return ["welcome", ...publishedSlugs].map((slug) => ({ url: pageUrl(slug) }))
}
