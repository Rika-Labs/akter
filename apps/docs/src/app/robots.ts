import type { MetadataRoute } from "next"

import { siteUrl } from "../content/build-origins.ts"

export const dynamic = "force-static"

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" }, sitemap: `${siteUrl}/sitemap.xml` }
}
