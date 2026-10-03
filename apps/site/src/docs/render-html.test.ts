import { describe, expect, it } from "vitest"
import type { ProseClasses } from "./render-html.ts"
import { renderHtml } from "./render-html.ts"

const keep = (href: string): string => href

const classes: ProseClasses = {
  paragraph: "p",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  step: "step",
  anchor: "anchor",
  list: "list",
  bullets: "bullets",
  numbers: "numbers",
  item: "item",
  link: "link",
  code: "code",
  strong: "strong",
  quote: "quote",
  rule: "rule",
  tableWrap: "wrap",
  table: "table",
  th: "th",
  td: "td",
  figure: "figure",
  caption: "caption",
  pre: "pre",
  codeBlock: "block",
  copy: "copy",
}

describe("renderHtml", () => {
  it("numbers a step heading, ids it like GitHub and lists it in the outline", async () => {
    const { html, outline } = await renderHtml(
      "## 1. Install\n\nRun it.\n\n### Notes\n",
      keep,
      classes,
    )

    expect(html).toContain('id="1-install"')
    expect(outline).toEqual([
      { id: "1-install", text: "Install", level: 2, step: "1" },
      { id: "notes", text: "Notes", level: 3 },
    ])
  })

  it("highlights code at build time and titles the block with its file", async () => {
    const { html } = await renderHtml(
      '```ts title="src/a.ts"\nexport const a = 1\n```\n',
      keep,
      classes,
    )

    expect(html).toContain("src/a.ts")
    expect(html).toContain('<span style="color:')
    expect(html).toContain("export")
  })

  it("escapes markup in text and code so a docs page cannot inject HTML", async () => {
    const { html } = await renderHtml("Use `<script>` and <b>raw</b> & more.\n", keep, classes)

    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("sends every link through the resolver and marks absolute ones external", async () => {
    const { html } = await renderHtml(
      "[a](x.md#y) and [b](https://pglite.dev)\n",
      (href) => (href.startsWith("x") ? "/docs/x#y" : href),
      classes,
    )

    expect(html).toContain('href="/docs/x#y"')
    expect(html).toContain('href="https://pglite.dev"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it("renders GFM tables inside a scroll wrapper and records section text for search", async () => {
    const { html, sections } = await renderHtml(
      "## Table\n\nIntro words.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
      keep,
      classes,
    )

    expect(html).toContain("<table")
    expect(html).toContain("<thead>")
    expect(sections).toEqual([{ id: "table", heading: "Table", text: "Intro words. a b 1 2" }])
  })
})
