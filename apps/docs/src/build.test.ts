import { BunServices } from "@effect/platform-bun"
import { layer } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { expect } from "vitest"

import { buildSite } from "./build.ts"
import { pageBase, pages } from "./pages.ts"

/** Builds the real `docs/` tree into a scoped directory and returns every output file by path. */
const buildRealSite = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const outDir = yield* fs.makeTempDirectoryScoped()

  yield* buildSite(path.join(import.meta.dirname, "../../../docs"), outDir)

  const files = new Map<string, string>()

  for (const entry of yield* fs.readDirectory(outDir, { recursive: true })) {
    const info = yield* fs.stat(path.join(outDir, entry))

    if (info.type === "File") files.set(entry, yield* fs.readFileString(path.join(outDir, entry)))
  }

  return files
})

layer(BunServices.layer)("buildSite on the repository's docs", (it) => {
  it.effect("writes an HTML page and a Markdown copy for every listed page, plus llms.txt", () =>
    Effect.gen(function* () {
      const site = yield* buildRealSite

      for (const page of pages) {
        expect(site.get(`${pageBase(page.source)}.html`)).toContain("<!doctype html>")
        expect(site.get(`${pageBase(page.source)}.md`)).toMatch(/^# /)
      }

      expect(site.get("index.html")).toContain("<title>Overview · Durable Actors</title>")
      expect(site.get("styles.css")).toContain("--primary")
    }),
  )

  it.effect("lists every page's Markdown copy in llms.txt under a section heading", () =>
    Effect.gen(function* () {
      const site = yield* buildRealSite

      const llms = site.get("llms.txt") ?? ""

      expect(llms).toMatch(/^# Durable Actors\n\n> /)

      for (const page of pages) expect(llms).toContain(`](${pageBase(page.source)}.md): `)

      expect(llms).toContain("## Optional")
    }),
  )

  it.effect("links contracts and decisions to the repository instead of publishing them", () =>
    Effect.gen(function* () {
      const site = yield* buildRealSite

      const serverApi = site.get("api/01-server-api.html") ?? ""

      expect(serverApi).toContain(
        'href="https://github.com/Rika-Labs/durable-actors/blob/main/docs/decisions/0010-one-way-effect-native-api.md"',
      )
      expect([...site.keys()].some((file) => file.includes("decisions/"))).toBe(false)
      expect([...site.keys()].some((file) => file.includes("contracts/"))).toBe(false)
    }),
  )
})
