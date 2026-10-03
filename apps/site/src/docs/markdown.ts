import type { Parent, PhrasingContent, Root, RootContent } from "mdast"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import { unified } from "unified"

const processor = unified().use(remarkParse).use(remarkGfm)

/** Parses GitHub-flavoured Markdown into its syntax tree without running any transform. */
export const parseMarkdown = (source: string): Root => processor.parse(source)

/** Any node the renderer walks: block content or inline content. */
export type Node = RootContent | PhrasingContent

const hasChildren = (node: Node): node is Node & Parent => "children" in node

const BLOCK_CONTAINERS = new Set(["table", "tableRow", "list", "listItem", "blockquote"])

/**
 * The visible text of a node, dropping all formatting; the basis of heading ids and labels. Block
 * containers join their children with a space so table cells and list items stay separate words.
 */
export const plainText = (node: Node): string => {
  if (hasChildren(node))
    return node.children.map(plainText).join(BLOCK_CONTAINERS.has(node.type) ? " " : "")

  return "value" in node ? node.value : ""
}

const NOT_SLUG = /[^\p{L}\p{N} _-]/gu

/**
 * Makes heading ids the way GitHub does, so anchors written for the repository's Markdown keep
 * working: lower case, punctuation removed, spaces to hyphens, repeats numbered.
 */
export const createSlugger = (): ((text: string) => string) => {
  const seen = new Map<string, number>()

  return (text) => {
    const base = text.toLowerCase().replace(NOT_SLUG, "").trim().replace(/ /g, "-")
    const count = seen.get(base) ?? 0

    seen.set(base, count + 1)

    return count === 0 ? base : `${base}-${count}`
  }
}

/** The `title="..."` attribute from a code fence's info string, or `undefined`. */
export const fenceTitle = (meta: string | null | undefined): string | undefined =>
  /title="([^"]+)"/.exec(meta ?? "")?.[1]

/**
 * The first prose paragraph of a document, as plain text, skipping lead-ins that end in a colon
 * because they only introduce a list or a code block, and fragments that do not open a sentence.
 * Used for page descriptions.
 */
export const firstParagraph = (source: string): string | undefined => {
  for (const node of parseMarkdown(source).children) {
    if (node.type !== "paragraph") continue

    const text = plainText(node).replace(/\s+/g, " ").trim()

    if (!text.endsWith(":") && /^[A-Z`]/.test(text) && text.length > 40) return text
  }

  return undefined
}
