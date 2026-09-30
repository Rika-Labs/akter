import { BunServices } from "@effect/platform-bun"
import { it, layer } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect } from "vitest"

import { brokenLinks, linkSources } from "./links.ts"

const repositoryRoot = new URL("../../..", import.meta.url).pathname

/**
 * One authoritative document per `linkSources` pattern. A scan that misses
 * any of them read the wrong root or a broken pattern, and would pass
 * without checking anything.
 */
const essentialDocuments = [
  "README.md",
  "docs/contracts/README.md",
  "apps/docs/README.md",
  "packages/durable-actors/README.md",
  "examples/orders/README.md",
  "tooling/oxlint/README.md",
  "infra/README.md",
]

describe("brokenLinks", () => {
  const files = new Map([
    ["docs/api/README.md", "# API\n\n## Calling actors\n"],
    ["docs/contracts/protocol.md", "# Wire protocol\n\n## Hosted assertions (ADR 0031)\n"],
    ["packages/core/src/index.ts", ""],
  ])

  const check = (markdown: string) =>
    brokenLinks({
      source: "docs/guides/concepts.md",
      markdown,
      read: (path) => Effect.succeed(files.get(path)),
    })

  it.effect("accepts existing files, headings, in-page anchors, and external links", () =>
    Effect.gen(function* () {
      const broken = yield* check(
        [
          "[api](../api/README.md#calling-actors)",
          "[protocol](../contracts/protocol.md#hosted-assertions-adr-0031)",
          "[code](../../packages/core/src/index.ts#L3)",
          "[site](https://effect.website)",
          "[here](#top)",
          "# Top",
        ].join("\n\n"),
      )

      expect(broken).toEqual([])
    }),
  )

  it.effect("reports a missing file, a missing heading, and a path above the repository", () =>
    Effect.gen(function* () {
      const broken = yield* check(
        [
          "[gone](../api/missing.md)",
          "[stale](../contracts/protocol.md#hosted-edge-assertions-adr-0031)",
          "[escape](../../../outside.md)",
        ].join("\n\n"),
      )

      expect(broken.map((link) => link.reason)).toEqual([
        "no such file",
        "no such heading",
        "outside the repository",
      ])
    }),
  )
})

layer(BunServices.layer)("repository documents", (it) => {
  it.effect("link only to files and headings that exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const read = Effect.fnUntraced(function* (relative: string) {
        const absolute = path.join(repositoryRoot, relative)

        if (!(yield* fs.exists(absolute))) return undefined

        const info = yield* fs.stat(absolute)

        return info.type === "File" && relative.endsWith(".md")
          ? yield* fs.readFileString(absolute)
          : ""
      })

      const sources = new Set<string>()

      for (const pattern of linkSources)
        for (const source of new Bun.Glob(pattern).scanSync(repositoryRoot))
          if (!source.includes("node_modules/")) sources.add(source)

      expect([...sources]).toEqual(expect.arrayContaining(essentialDocuments))

      const broken: Array<string> = []

      for (const source of [...sources].sort())
        for (const link of yield* brokenLinks({
          source,
          markdown: yield* fs.readFileString(path.join(repositoryRoot, source)),
          read,
        }))
          broken.push(`${link.source} -> ${link.href} (${link.reason})`)

      expect(broken).toEqual([])
    }),
  )
})
