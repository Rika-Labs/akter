import { describe, expect, it } from "vitest"
import { createSlugger, fenceTitle, firstParagraph, parseMarkdown, plainText } from "./markdown.ts"

describe("parseMarkdown", () => {
  it("parses GFM tables, which plain CommonMark would read as a paragraph", () => {
    const tree = parseMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\n")

    expect(tree.children[0]?.type).toBe("table")
  })

  it("keeps a code fence's language and info string", () => {
    const tree = parseMarkdown('```ts title="src/a.ts"\nconst a = 1\n```\n')
    const fence = tree.children[0]

    expect(fence?.type).toBe("code")
    expect(fence?.type === "code" ? [fence.lang, fence.meta] : []).toEqual([
      "ts",
      'title="src/a.ts"',
    ])
  })
})

describe("plainText", () => {
  it("reads through emphasis, links and inline code", () => {
    const tree = parseMarkdown("## The `Order` actor is **durable** [now](x.md)\n")
    const heading = tree.children[0]

    expect(heading === undefined ? "" : plainText(heading)).toBe("The Order actor is durable now")
  })
})

describe("createSlugger", () => {
  it("matches GitHub's ids for headings with punctuation", () => {
    const slug = createSlugger()

    expect(slug("Implemented subset (M3.4)")).toBe("implemented-subset-m34")
    expect(slug("1. Install")).toBe("1-install")
    expect(slug("What PGlite is for")).toBe("what-pglite-is-for")
  })

  it("numbers a repeated heading instead of reusing its id", () => {
    const slug = createSlugger()

    expect([slug("Example"), slug("Example"), slug("Example")]).toEqual([
      "example",
      "example-1",
      "example-2",
    ])
  })
})

describe("fenceTitle", () => {
  it("reads the title attribute and ignores a missing one", () => {
    expect(fenceTitle('title="src/order/layer.ts"')).toBe("src/order/layer.ts")
    expect(fenceTitle(null)).toBeUndefined()
    expect(fenceTitle("")).toBeUndefined()
  })
})

describe("firstParagraph", () => {
  it("skips headings, code and a lead-in that ends with a colon", () => {
    const source =
      "## Why\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nRun it like this:\n\nTests run the **real** turn path in your database.\n"

    expect(firstParagraph(source)).toBe("Tests run the real turn path in your database.")
  })

  it("is empty when the document has no prose", () => {
    expect(firstParagraph("## Only a heading\n")).toBeUndefined()
  })
})
