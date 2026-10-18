import { createMDX } from "fumadocs-mdx/next"
import type { NextConfig } from "next"
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js"

const withMDX = createMDX()

/**
 * A static export of every page, served by a plain file host. Dev serves the Markdown twin
 * of a page at `<page>.md` through a rewrite; the export has no rewrites, so the build step
 * writes those files itself.
 */
export default (phase: string): NextConfig =>
  withMDX({
    output: "export",
    reactStrictMode: true,
    trailingSlash: false,
    devIndicators: false,
    images: { unoptimized: true },
    rewrites:
      phase === PHASE_DEVELOPMENT_SERVER
        ? async () => [{ source: "/:slug*.md", destination: "/md/:slug*" }]
        : undefined,
  })
