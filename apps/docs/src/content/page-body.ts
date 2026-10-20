import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import remarkStringify from "remark-stringify"
import { unified } from "unified"
import { VFile } from "vfile"

import { stripFrontmatter } from "./headings.ts"
import { remarkAdmonitionTags, remarkDocsLinks, remarkLeadingHeading } from "./remark-docs.ts"
import { docsDirectory, readRepositoryFile } from "./repository.ts"
import { join } from "node:path"

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkLeadingHeading)
  .use(remarkAdmonitionTags)
  .use(remarkDocsLinks)
  .use(remarkStringify, {
    bullet: "-",
    emphasis: "_",
    fences: true,
    listItemIndent: "one",
    rule: "-",
  })

/**
 * A published page's Markdown body for its `.md` twin: the source without frontmatter or
 * its leading heading, with links rewritten exactly as they are on the HTML page.
 */
export const pageBody = (slug: string): string =>
  String(
    processor.processSync(
      new VFile({
        value: stripFrontmatter(readRepositoryFile(`docs/${slug}.md`)),
        path: join(docsDirectory, `${slug}.md`),
      }),
    ),
  )
