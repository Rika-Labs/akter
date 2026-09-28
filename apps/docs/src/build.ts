import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime, Path } from "effect"

import { renderLlmsText } from "./llms.ts"
import { pageBase, pages } from "./pages.ts"
import { readHeader, renderHtmlPage, renderMarkdownCopy, type SitePage } from "./render.ts"

/**
 * Renders every page in `pages` from `docsDir` into `outDir`: an HTML page and
 * a Markdown copy per page, `llms.txt`, and the stylesheet. `outDir` is
 * replaced, so a page removed from the site does not linger in the output.
 */
export const buildSite = Effect.fn("buildSite")(function* (docsDir: string, outDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const site: ReadonlyArray<SitePage> = yield* Effect.forEach(pages, (page) =>
    Effect.gen(function* () {
      const markdown = yield* fs.readFileString(path.join(docsDir, page.source))

      const header = yield* readHeader({ source: page.source, markdown })

      return { ...page, ...header, markdown }
    }),
  )

  const published = new Set(site.map((page) => page.source))

  const files = yield* Effect.forEach(site, (page) =>
    Effect.all([
      renderHtmlPage({ page, site }).pipe(
        Effect.map((text) => ({ path: `${pageBase(page.source)}.html`, text })),
      ),
      renderMarkdownCopy({ page, published }).pipe(
        Effect.map((text) => ({ path: `${pageBase(page.source)}.md`, text })),
      ),
    ]),
  )

  yield* fs.remove(outDir, { recursive: true, force: true })

  for (const file of [...files.flat(), { path: "llms.txt", text: renderLlmsText(site) }]) {
    const target = path.join(outDir, file.path)
    yield* fs.makeDirectory(path.dirname(target), { recursive: true })
    yield* fs.writeFileString(target, file.text)
  }

  yield* fs.copyFile(path.join(import.meta.dirname, "styles.css"), path.join(outDir, "styles.css"))

  return site
})

if (import.meta.main) {
  const runtime = ManagedRuntime.make(BunServices.layer)

  await runtime
    .runPromise(
      Effect.gen(function* () {
        const path = yield* Path.Path

        const root = path.join(import.meta.dirname, "..")

        const site = yield* buildSite(path.join(root, "../../docs"), path.join(root, "dist"))

        yield* Effect.log(`Built ${site.length} pages and llms.txt into apps/docs/dist.`)
      }),
    )
    .finally(() => runtime.dispose())
}
