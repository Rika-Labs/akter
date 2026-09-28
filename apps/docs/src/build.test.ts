import { BunServices } from "@effect/platform-bun"
import { layer } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { expect } from "vitest"

import { buildSite } from "./build.ts"
import { pageBase, pages } from "./pages.ts"

const hasScheme = /^[a-z][a-z0-9+.-]*:/i

const blobPrefix = "https://github.com/Rika-Labs/durable-actors/blob/main/"

const htmlLinks = (html: string) =>
  [...html.matchAll(/ (?:href|src)="([^"]*)"/g)].map((match) =>
    (match[1] ?? "").replaceAll("&amp;", "&"),
  )

const markdownLinks = (markdown: string) => {
  const hrefs: Array<string> = []

  Bun.markdown.render(markdown, {
    link: (children, meta) => {
      hrefs.push(meta.href)

      return children
    },
  })

  return hrefs
}

const headingIds = (html: string) => new Set([...html.matchAll(/ id="([^"]*)"/g)].map((m) => m[1]))

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

/** Resolves `href` from the output file `from`; `undefined` for external links. */
const localTarget = (from: string, href: string) => {
  if (hasScheme.test(href) || href.startsWith("//")) return undefined

  const url = new URL(href, `https://site.invalid/${from}`)

  return { file: decodeURIComponent(url.pathname.slice(1)), anchor: url.hash.slice(1) }
}

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

  it.effect("resolves every local link and anchor in every HTML page", () =>
    Effect.gen(function* () {
      const site = yield* buildRealSite

      const broken: Array<string> = []

      for (const [file, text] of site) {
        if (!file.endsWith(".html")) continue

        for (const href of htmlLinks(text)) {
          const target = localTarget(file, href)

          if (target === undefined) continue

          const content = site.get(target.file)

          if (content === undefined) broken.push(`${file} -> ${href} (no file)`)
          else if (target.anchor !== "" && !headingIds(content).has(target.anchor))
            broken.push(`${file} -> ${href} (no anchor)`)
        }
      }

      expect(broken).toEqual([])
    }),
  )

  it.effect("keeps Markdown copies and llms.txt linked to published Markdown or to GitHub", () =>
    Effect.gen(function* () {
      const site = yield* buildRealSite

      const broken: Array<string> = []

      for (const [file, text] of site) {
        if (!file.endsWith(".md") && file !== "llms.txt") continue

        for (const href of markdownLinks(text)) {
          const target = localTarget(file, href)

          if (target === undefined || href.startsWith("#")) continue

          if (!target.file.endsWith(".md") || !site.has(target.file))
            broken.push(`${file} -> ${href} (not a published Markdown copy)`)
        }
      }

      expect(broken).toEqual([])
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

  it.effect("points every GitHub link at a path that exists in the repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const site = yield* buildRealSite

      const repositoryRoot = path.join(import.meta.dirname, "../../..")

      const paths = new Set<string>()

      for (const [file, text] of site) {
        const links = file.endsWith(".html") ? htmlLinks(text) : markdownLinks(text)

        for (const href of links)
          if (href.startsWith(blobPrefix)) paths.add(decodeURIComponent(new URL(href).pathname))
      }

      const missing: Array<string> = []

      for (const url of paths) {
        const repositoryPath = url.slice(new URL(blobPrefix).pathname.length)

        if (!(yield* fs.exists(path.join(repositoryRoot, repositoryPath))))
          missing.push(repositoryPath)
      }

      expect(paths.size).toBeGreaterThan(0)
      expect(missing).toEqual([])
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
