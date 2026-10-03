import type {
  Code,
  Heading,
  List,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from "mdast"
import { escapeMarkup as escapeHtml } from "../escape-markup.ts"
import { highlightCode } from "../syntax/highlight-code.ts"
import { createSlugger, fenceTitle, parseMarkdown, plainText } from "./markdown.ts"

/** A heading the page's outline lists. */
export interface Outline {
  readonly id: string
  readonly text: string
  readonly level: 2 | 3
  readonly step?: string | undefined
}

/** The text under one heading, which the search index records. */
export interface Section {
  readonly id: string
  readonly heading: string
  readonly text: string
}

/** What rendering a document yields: its HTML, outline, and sections for search. */
export interface Rendered {
  readonly html: string
  readonly outline: ReadonlyArray<Outline>
  readonly sections: ReadonlyArray<Section>
}

/** The class names the renderer puts on each element, one per entry of the prose styles. */
export interface ProseClasses {
  readonly paragraph: string
  readonly h2: string
  readonly h3: string
  readonly h4: string
  readonly step: string
  readonly anchor: string
  readonly list: string
  readonly bullets: string
  readonly numbers: string
  readonly item: string
  readonly link: string
  readonly code: string
  readonly strong: string
  readonly quote: string
  readonly rule: string
  readonly tableWrap: string
  readonly table: string
  readonly th: string
  readonly td: string
  readonly figure: string
  readonly caption: string
  readonly pre: string
  readonly codeBlock: string
  readonly copy: string
}

const NUMBERED = /^(\d+)\.\s+(.+)$/

const SNIPPET = 220

const HEADING_STYLES = ["h2", "h3", "h4"] as const

/**
 * Renders Markdown to HTML for the documentation pages. Elements carry StyleX classes from the
 * prose styles, code is highlighted at build time, and links go through `resolve` so repository
 * paths become site or GitHub URLs.
 */
export const renderHtml = async (
  markdown: string,
  resolve: (href: string) => string,
  classes: ProseClasses,
): Promise<Rendered> => {
  const cls = (...names: ReadonlyArray<keyof ProseClasses>): string =>
    ` class="${names.map((name) => classes[name]).join(" ")}"`

  const tree: Root = parseMarkdown(markdown)
  const slug = createSlugger()
  const outline: Array<Outline> = []
  const sections: Array<Section> = []
  const highlighted = new Map<Code, string>()

  const collect = async (nodes: ReadonlyArray<RootContent>): Promise<void> => {
    for (const node of nodes) {
      if (node.type === "code")
        highlighted.set(node, await highlightCode(node.value, node.lang ?? "text"))
      if ("children" in node) await collect(node.children as ReadonlyArray<RootContent>)
    }
  }

  await collect(tree.children)

  const inline = (nodes: ReadonlyArray<PhrasingContent>): string => nodes.map(phrase).join("")

  const phrase = (node: PhrasingContent): string => {
    switch (node.type) {
      case "text":
        return escapeHtml(node.value)
      case "strong":
        return `<strong${cls("strong")}>${inline(node.children)}</strong>`
      case "emphasis":
        return `<em>${inline(node.children)}</em>`
      case "delete":
        return `<del>${inline(node.children)}</del>`
      case "inlineCode":
        return `<code${cls("code")}>${escapeHtml(node.value)}</code>`
      case "break":
        return "<br />"
      case "link": {
        const href = resolve(node.url)
        const external = /^https?:/.test(href)
        return `<a href="${escapeHtml(href)}"${cls("link")}${external ? ' rel="noopener noreferrer"' : ""}>${inline(node.children)}</a>`
      }
      case "image":
        return `<img src="${escapeHtml(node.url)}" alt="${escapeHtml(node.alt ?? "")}" />`
      default:
        return plainText(node)
    }
  }

  let current: { id: string; heading: string; text: Array<string> } | undefined

  const closeSection = (): void => {
    if (current === undefined) return

    sections.push({
      id: current.id,
      heading: current.heading,
      text: current.text.join(" ").replace(/\s+/g, " ").trim().slice(0, SNIPPET),
    })
  }

  const heading = (node: Heading): string => {
    const text = plainText(node)
    const id = slug(text)
    const level = Math.min(Math.max(node.depth, 2), 4)
    const tag = `h${level}`
    const numbered = level === 2 ? NUMBERED.exec(text) : null
    const label = numbered?.[2] ?? text

    if (level <= 3) {
      closeSection()
      current = { id, heading: label, text: [] }
      outline.push({ id, text: label, level: level === 2 ? 2 : 3, step: numbered?.[1] })
    }

    const anchor = `<a href="#${id}"${cls("anchor")} aria-label="Link to this section">#</a>`
    const chip = numbered === null ? "" : `<span${cls("step")}>${numbered[1]}</span>`
    const body = numbered === null ? inline(node.children) : escapeHtml(label)
    const style = HEADING_STYLES[level - 2] ?? "h4"

    return `<${tag} id="${id}"${cls(style)}>${anchor}${chip}${numbered === null ? body : `<span>${body}</span>`}</${tag}>`
  }

  const listItem = (item: ListItem): string => {
    const only = item.children.length === 1 ? item.children[0] : undefined
    const content =
      only?.type === "paragraph" ? inline(only.children) : item.children.map(block).join("")

    return `<li${cls("item")}>${content}</li>`
  }

  const list = (node: List): string => {
    const tag = node.ordered === true ? "ol" : "ul"
    const start =
      node.ordered === true && node.start !== 1 && node.start != null
        ? ` start="${node.start}"`
        : ""

    return `<${tag}${start}${cls("list", node.ordered === true ? "numbers" : "bullets")}>${node.children.map(listItem).join("")}</${tag}>`
  }

  const table = (node: Table): string => {
    const [head, ...rows] = node.children
    const cells = (row: Table["children"][number], tag: "th" | "td"): string =>
      row.children
        .map((cell, index) => {
          const align = node.align?.[index]
          const style = align == null ? "" : ` style="text-align:${align}"`
          return `<${tag}${cls(tag)}${style}>${inline(cell.children)}</${tag}>`
        })
        .join("")

    return `<div${cls("tableWrap")}><table${cls("table")}><thead><tr>${head === undefined ? "" : cells(head, "th")}</tr></thead><tbody>${rows.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody></table></div>`
  }

  const code = (node: Code): string => {
    const title = fenceTitle(node.meta)
    const caption =
      title === undefined
        ? ""
        : `<figcaption${cls("caption")}><span>${escapeHtml(title)}</span></figcaption>`

    return `<figure${cls("figure")}>${caption}<pre${cls("pre")} tabindex="0"><code${cls("codeBlock")}>${highlighted.get(node) ?? escapeHtml(node.value)}</code></pre><button type="button" data-copy-code${cls("copy")}>Copy</button></figure>`
  }

  const block = (node: RootContent): string => {
    const text = plainText(node)

    if (current !== undefined && node.type !== "heading") current.text.push(text)

    switch (node.type) {
      case "heading":
        return heading(node)
      case "paragraph":
        return `<p${cls("paragraph")}>${inline(node.children)}</p>`
      case "list":
        return list(node)
      case "blockquote":
        return `<blockquote${cls("quote")}>${node.children.map(block).join("")}</blockquote>`
      case "code":
        return code(node)
      case "table":
        return table(node)
      case "thematicBreak":
        return `<hr${cls("rule")} />`
      default:
        return ""
    }
  }

  const html = tree.children.map(block).join("\n")

  closeSection()

  return { html, outline, sections }
}
