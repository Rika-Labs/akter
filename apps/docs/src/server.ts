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
 *
 * Paths are compared against the real path of `distDir`, so a symlink inside
 * the site cannot serve a file outside it, and the resolved file of every
 * request is checked against it because decoded `%2F` separators can climb out
 * of the site. `distDir` may not be built yet when the server starts.
 */
export const staticSiteHandler = Effect.fn("staticSiteHandler")(function* (distDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const root = yield* fs
    .realPath(path.resolve(distDir))
    .pipe(Effect.orElseSucceed(() => path.resolve(distDir)))

  const insideRoot = (file: string) => file.startsWith(`${root}${path.sep}`)

  /** The file's real path when it is a regular file inside the site. */
  const servableFile = (file: string) =>
    Effect.gen(function* () {
      const real = yield* fs.realPath(file)

      if (!insideRoot(real)) return Option.none()

      const info = yield* fs.stat(real)

      return info.type === "File" ? Option.some(real) : Option.none()
    }).pipe(Effect.orElseSucceed(() => Option.none<string>()))

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

      if (!insideRoot(file)) return notFound()

      const servable = yield* servableFile(file)

      if (Option.isNone(servable)) continue

      const type = contentTypes.get(path.extname(servable.value)) ?? "application/octet-stream"

      return new Response(request.method === "HEAD" ? null : Bun.file(servable.value), {
        headers: { "content-type": type },
      })
    }

    return notFound()
  })

  const context = yield* Effect.context<never>()

  return (request: Request) => Effect.runPromiseWith(context)(staticResponse(request))
})
