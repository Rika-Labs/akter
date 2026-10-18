import { frontmatterSchema, defineConfig, defineDocs } from "fumadocs-mdx/config"
import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { createCssVariablesTheme } from "shiki"
import { z } from "zod"

import { firstHeading } from "./src/content/headings.ts"
import { publishedSlugs } from "./src/content/navigation.ts"
import {
  remarkAdmonitionTags,
  remarkDocsLinks,
  remarkLeadingHeading,
} from "./src/content/remark-docs.ts"
import { docsDirectory } from "./src/content/repository.ts"

/**
 * The published pages, read in place from the repository's `docs/` directory. Only the
 * slugs in the navigation are collected, so nothing else under `docs/` is ever built. The
 * meta collection is pinned to a file that does not exist: the page tree comes from the
 * navigation, not from `meta.json` files. A page without a `title` in its frontmatter
 * takes its first heading.
 */
export const docs = defineDocs({
  dir: "../../docs",
  docs: {
    files: publishedSlugs.map((slug) => `${slug}.md`),
    schema: (context) => {
      const heading = firstHeading(
        readFileSync(
          isAbsolute(context.path) ? context.path : join(docsDirectory, context.path),
          "utf8",
        ),
      )

      return frontmatterSchema.extend({
        title: heading === undefined ? z.string() : z.string().default(heading),
        sidebarTitle: z.string().optional(),
      })
    },
  },
  meta: { files: ["meta.json"] },
})

/**
 * Code colours are CSS variables, so one stylesheet recolours every block for light and dark
 * with no second set of spans and no script. The tokenizer's default time limit, 500 ms a
 * line, makes a loaded machine end a line's tokens early and emit the rest as one span, so
 * the same commit highlighted differently from one build to the next; zero removes the limit.
 */
const codeTheme = createCssVariablesTheme({
  name: "akter",
  variablePrefix: "--ak-code-",
  variableDefaults: {},
  fontStyle: true,
})

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkLeadingHeading, remarkAdmonitionTags, remarkDocsLinks],
    rehypeCodeOptions: {
      themes: { light: codeTheme },
      defaultColor: "light",
      tokenizeTimeLimit: 0,
    },
  },
})
