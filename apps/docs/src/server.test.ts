import { BunServices } from "@effect/platform-bun"
import { layer } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { expect } from "vitest"

import { staticSiteHandler } from "./server.ts"

/** A built site in a scoped directory, with one file beside it that must stay unreachable. */
const siteHandler = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const root = yield* fs.makeTempDirectoryScoped()

  const files = [
    ["dist/index.html", "<p>home</p>"],
    ["dist/api/02-context.html", "<p>context</p>"],
    ["dist/api/02-context.md", "# Context\n"],
    ["dist/llms.txt", "# Durable Actors\n"],
    ["secret.txt", "outside the site"],
  ] as const

  for (const [file, text] of files) {
    yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
    yield* fs.writeFileString(path.join(root, file), text)
  }

  const serve = yield* staticSiteHandler(path.join(root, "dist"))

  return (pathname: string, method = "GET") =>
    Effect.promise(() => serve(new Request(`http://docs.test${pathname}`, { method })))
})

const bodyText = (response: Response) => Effect.promise(() => response.text())

layer(BunServices.layer)("staticSiteHandler", (it) => {
  it.effect("serves the root, pages, Markdown copies and llms.txt with their content types", () =>
    Effect.gen(function* () {
      const get = yield* siteHandler

      const cases = [
        ["/", "<p>home</p>", "text/html; charset=utf-8"],
        ["/api/02-context.html", "<p>context</p>", "text/html; charset=utf-8"],
        ["/api/02-context", "<p>context</p>", "text/html; charset=utf-8"],
        ["/api/02-context.md", "# Context\n", "text/markdown; charset=utf-8"],
        ["/llms.txt", "# Durable Actors\n", "text/plain; charset=utf-8"],
      ] as const

      for (const [pathname, body, type] of cases) {
        const response = yield* get(pathname)

        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toBe(type)
        expect(yield* bodyText(response)).toBe(body)
      }
    }),
  )

  it.effect("answers HEAD without a body", () =>
    Effect.gen(function* () {
      const get = yield* siteHandler

      const response = yield* get("/llms.txt", "HEAD")

      expect(response.status).toBe(200)
      expect(yield* bodyText(response)).toBe("")
    }),
  )

  it.effect("returns 404 for missing files, other methods, and paths outside the site", () =>
    Effect.gen(function* () {
      const get = yield* siteHandler

      for (const pathname of [
        "/missing.html",
        "/api/",
        "/..%2Fsecret.txt",
        "/%2e%2e/secret.txt",
        "/%E0",
      ])
        expect((yield* get(pathname)).status).toBe(404)

      expect((yield* get("/llms.txt", "POST")).status).toBe(404)
    }),
  )
})
