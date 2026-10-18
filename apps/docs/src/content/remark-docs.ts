import type { Blockquote, Html, Root } from "mdast"
import { relative } from "node:path"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { visit } from "unist-util-visit"
import type { VFile } from "vfile"

import { linkEnvironment } from "./link-environment.ts"
import { resolveLink } from "./links.ts"
import { docsDirectory } from "./repository.ts"

const ADMONITION = /^<(Note|Info|Tip|Check|Warning)>\s*([\s\S]*?)\s*<\/\1>$/

const CALLOUT_TYPES = new Map([
  ["Note", "info"],
  ["Info", "info"],
  ["Tip", "idea"],
  ["Check", "success"],
  ["Warning", "warning"],
])

/**
 * Drops the page's first level-one heading. The page header already shows the frontmatter
 * title, while the Markdown keeps its heading so it still reads well on GitHub.
 */
export const remarkLeadingHeading = () => (tree: Root) => {
  const index = tree.children.findIndex((node) => node.type === "heading" && node.depth === 1)

  if (index !== -1) tree.children.splice(index, 1)
}

/**
 * Turns Mintlify-style `<Warning>` blocks into callouts. The pages are parsed as plain
 * Markdown, so these arrive as raw HTML blocks.
 */
export const remarkAdmonitionTags = () => (tree: Root) => {
  visit(tree, "html", (node: Html, index, parent) => {
    const match = ADMONITION.exec(node.value.trim())

    if (match === null || parent === undefined || index === undefined) return

    const callout: Blockquote = {
      type: "blockquote",
      children: unified()
        .use(remarkParse)
        .parse(match[2] ?? "").children as Blockquote["children"],
      data: {
        hName: "callout",
        hProperties: { type: CALLOUT_TYPES.get(match[1] ?? "") ?? "info" },
      },
    }

    parent.children[index] = callout
  })
}

/**
 * Rewrites every link in a published page: published targets become site routes, other
 * repository files become GitHub URLs, and a dead link fails the build.
 */
export const remarkDocsLinks = () => (tree: Root, file: VFile) => {
  const source = relative(docsDirectory, file.path).replace(/\.md$/, "")
  const problems: Array<string> = []

  visit(tree, (node) => {
    if (node.type !== "link" && node.type !== "definition") return

    const resolution = resolveLink({ environment: linkEnvironment, source, href: node.url })

    if ("problem" in resolution) problems.push(`${node.url}: ${resolution.problem}`)
    else node.url = resolution.href
  })

  if (problems.length > 0)
    throw new Error(`Dead links in docs/${source}.md:\n${problems.join("\n")}`)
}
