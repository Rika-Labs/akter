import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { treeDifferences } from "./tree-differences.ts"

const tree = (files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), "tree-"))

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), content)
  }

  return root
}

describe("treeDifferences", () => {
  it("reports nothing for trees with the same files and bytes", () => {
    const files = { "a.html": "x", "_next/static/b.js": "y" }

    expect(treeDifferences(tree(files), tree(files))).toEqual([])
  })

  it("reports a file whose contents differ by one byte", () => {
    expect(treeDifferences(tree({ "a/b.html": "span" }), tree({ "a/b.html": "spaN" }))).toEqual([
      "differs: a/b.html",
    ])
  })

  it("reports a file present in one tree only, naming which", () => {
    expect(
      treeDifferences(
        tree({ "a.html": "x", "id1/m.js": "m" }),
        tree({ "a.html": "x", "id2/m.js": "m" }),
      ),
    ).toEqual(["only in the first build: id1/m.js", "only in the second build: id2/m.js"])
  })
})
