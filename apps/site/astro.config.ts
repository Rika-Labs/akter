import sitemap from "@astrojs/sitemap"
import stylex from "@stylexjs/unplugin"
import { defineConfig } from "astro/config"
import { siteUrl } from "./src/site.ts"

const modernBrowsers = {
  chrome: 123 << 16,
  edge: 123 << 16,
  firefox: 120 << 16,
  safari: (17 << 16) | (5 << 8),
}

export default defineConfig({
  site: siteUrl,
  output: "static",
  integrations: [sitemap()],
  build: { format: "directory" },
  vite: {
    plugins: [
      stylex.vite({ useCSSLayers: false, lightningcssOptions: { targets: modernBrowsers } }),
    ],
  },
})
