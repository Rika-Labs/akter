import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"
import { slugFor } from "./docs/paths.ts"

/**
 * The documentation pages are the repository's own Markdown under `docs/`, read at build time so
 * the site cannot drift from them. Entries are keyed by their URL slug; the Markdown itself is
 * rendered by the site's renderer, which resolves links, highlights code and styles with tokens.
 */
const docs = defineCollection({
  loader: glob({
    base: "../../docs",
    pattern: [
      "quickstart.md",
      "guides/*.md",
      "api/*.md",
      "product/fit-and-non-fit.md",
      "!guides/README.md",
    ],
    generateId: ({ entry }) => slugFor(entry),
  }),
})

export const collections = { docs }
