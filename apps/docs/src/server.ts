import { Effect, FileSystem, Option, Path } from "effect"

const contentTypes: ReadonlyMap<string, string> = new Map([
  [".html", "text/html; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
])

const notFound = () =>
  new Response("Not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })

/**
 * Builds a fetch handler that serves the built site in `distDir` as static
 * files. `/` serves `index.html`, and an address without an extension falls
 * back to its `.html` page.
 */
export const staticSiteHandler = Effect.fn("staticSiteHandler")(function* (distDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const root = path.resolve(distDir)

  const isFile = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    )

  const staticResponse = Effect.fn("staticResponse")(function* (request: Request) {
    if (request.method !== "GET" && request.method !== "HEAD") return notFound()

    const pathname = yield* Effect.option(
      Effect.try(() => decodeURIComponent(new URL(request.url).pathname)),
    )

    if (Option.isNone(pathname)) return notFound()

    const requested = pathname.value.endsWith("/") ? `${pathname.value}index.html` : pathname.value

    const candidates =
      path.extname(requested) === "" ? [requested, `${requested}.html`] : [requested]

    for (const candidate of candidates) {
      const file = path.resolve(root, `.${candidate}`)

      // Decoded `%2F` separators can climb out of the site, so the resolved
      // file is checked against the output directory.
      if (!file.startsWith(`${root}${path.sep}`)) return notFound()

      if (!(yield* isFile(file))) continue

      const type = contentTypes.get(path.extname(file)) ?? "application/octet-stream"

      return new Response(request.method === "HEAD" ? null : Bun.file(file), {
        headers: { "content-type": type },
      })
    }

    return notFound()
  })

  const context = yield* Effect.context<never>()

  return (request: Request) => Effect.runPromiseWith(context)(staticResponse(request))
})
