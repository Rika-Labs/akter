import sitemap from "@astrojs/sitemap"
import stylex from "@stylexjs/unplugin"
import type { AstroIntegration } from "astro"
import { defineConfig } from "astro/config"
import { siteUrl } from "./src/site.ts"

const modernBrowsers = {
  chrome: 123 << 16,
  edge: 123 << 16,
  firefox: 120 << 16,
  safari: (17 << 16) | (5 << 8),
}

/**
 * Serves every documentation page as raw Markdown at `/docs/<slug>.md`. The route is injected
 * because a file route named `[...slug].md` cannot satisfy the repository's file naming rule.
 */
const markdownPages: AstroIntegration = {
  name: "markdown-pages",
  hooks: {
    "astro:config:setup": ({ injectRoute }) => {
      injectRoute({
        pattern: "/docs/[...slug].md",
        entrypoint: "./src/docs/markdown-route.ts",
        prerender: true,
      })
    },
  },
}

export default defineConfig({
  site: siteUrl,
  output: "static",
  integrations: [sitemap(), markdownPages],
  build: { format: "directory" },
  vite: {
    plugins: [
      stylex.vite({ useCSSLayers: false, lightningcssOptions: { targets: modernBrowsers } }),
    ],
  },
})
