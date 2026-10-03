import { describe, expect, it } from "vitest"
import { assemble, prepare } from "./prepare.ts"

const document = `# Quickstart

**Responsibility:** take a developer from nothing to a tested actor.  
**Authority:** operational.  
**Owner role:** API.  
**Change policy:** change with the API.

You need Bun 1.4.2 or later.
No Docker.

## 1. Install

\`\`\`sh
bun add x
\`\`\`
`

describe("prepare", () => {
  it("drops the maintainers' block and lifts the first paragraph as the introduction", () => {
    const prepared = prepare(document)

    expect(prepared.title).toBe("Quickstart")
    expect(prepared.intro).toBe("You need Bun 1.4.2 or later. No Docker.")
    expect(prepared.body.startsWith("## 1. Install")).toBe(true)
    expect(prepared.body).not.toContain("Responsibility")
  })

  it("keeps a first block that is not a paragraph in the body instead of using it as the introduction", () => {
    const prepared = prepare("# Table page\n\n| a | b |\n| - | - |\n| 1 | 2 |\n")

    expect(prepared.intro).toBe("")
    expect(prepared.body).toContain("| a | b |")
  })

  it("assembles the parts back into Markdown an agent can read", () => {
    expect(assemble(prepare(document))).toBe(
      "# Quickstart\n\nYou need Bun 1.4.2 or later. No Docker.\n\n## 1. Install\n\n```sh\nbun add x\n```\n",
    )
  })
})
