import { describe, expect, it } from "vitest"

import { firstHeading, headingAnchors, stripFrontmatter } from "./headings.ts"

describe("firstHeading", () => {
  it("reads the first level-one heading after frontmatter and flattens code spans and links", () => {
    expect(
      firstHeading('---\ntitle: "X"\n---\n\n# The `akter` [CLI](./cli.md)\n\n# Second\n'),
    ).toBe("The akter CLI")
  })

  it("ignores a # comment inside a fenced block and a deeper heading before the first level one", () => {
    expect(firstHeading("## Not it\n\n```sh\n# not a heading\n```\n\n# Real\n")).toBe("Real")
  })

  it("reports no heading when the page has none", () => {
    expect(firstHeading("---\ntitle: x\n---\nPlain text\n")).toBeUndefined()
  })
})

describe("headingAnchors", () => {
  it("numbers repeated headings and drops punctuation like GitHub", () => {
    const anchors = headingAnchors(
      "# Top\n\n## Runner usage\n\n## Runner usage\n\n### Several runners (0.2)\n",
    )

    expect([...anchors]).toEqual(["top", "runner-usage", "runner-usage-1", "several-runners-02"])
  })

  it("does not anchor a comment inside a code fence", () => {
    expect(headingAnchors("```sh\n# comment\n```\n").size).toBe(0)
  })
})

describe("stripFrontmatter", () => {
  it("removes only a leading block", () => {
    expect(stripFrontmatter("---\na: 1\n---\nBody\n---\nrule\n")).toBe("Body\n---\nrule\n")
  })
})
