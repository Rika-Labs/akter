import { execFileSync } from "node:child_process"

import { createMDX } from "fumadocs-mdx/next"
import type { NextConfig } from "next"
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js"

const withMDX = createMDX()

/**
 * A static export of every page, served by a plain file host. Dev serves the Markdown twin
 * of a page at `<page>.md` through a rewrite; the export has no rewrites, so the build step
 * writes those files itself. The build id is the commit being built: Next would otherwise
 * draw a random one, and two builds of one commit would differ in the id's directory and in
 * every page that names it. A new commit changes the id, so the build manifests under
 * `/_next/static/` that cache for a year never go stale.
 */
export default (phase: string): NextConfig =>
  withMDX({
    output: "export",
    reactStrictMode: true,
    trailingSlash: false,
    devIndicators: false,
    images: { unoptimized: true },
    generateBuildId:
      phase === PHASE_DEVELOPMENT_SERVER
        ? undefined
        : () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    rewrites:
      phase === PHASE_DEVELOPMENT_SERVER
        ? async () => [{ source: "/:slug*.md", destination: "/md/:slug*" }]
        : undefined,
  })
