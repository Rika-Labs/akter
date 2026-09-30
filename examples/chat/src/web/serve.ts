/**
 * The chat room served to a browser: Actors.serve under /api, the page at
 * /rooms/<id>?user=<name>, and the same room with @durable-actors/react at
 * /react/rooms/<id>. Presence and live cursors are at /cursors/<doc> and
 * /react/cursors/<doc>, and the room with a persisted offline queue is at
 * /offline/rooms/<id>. PGlite in memory unless DATABASE_URL names Postgres.
 *   bun run web            # http://localhost:3003/rooms/lobby?user=alice
 *                          # http://localhost:3003/cursors/notes?user=alice
 */
import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Actors, Database } from "@durable-actors/core/runtime"
import { Config, Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { actors } from "../app.ts"
import { Cursor } from "../cursor/contract.ts"
import { CursorLive } from "../cursor/layer.ts"
import { Room } from "../room/contract.ts"
import { demoAuth } from "../server.ts"

const api = Actors.serve({ actors: [Room, Cursor], auth: demoAuth, basePath: "/api" })

const served = CursorLive.pipe(Layer.provideMerge(actors))

/** The pages' scripts, bundled for browsers from their entry files once at startup, and their HTML. */
const pages = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const built = yield* Effect.promise(() =>
      Bun.build({
        entrypoints: ["app.ts", "react.tsx", "cursors.ts", "cursors-react.tsx", "offline.ts"].map(
          (file) => `${import.meta.dir}/${file}`,
        ),
        target: "browser",
        minify: true,
      }),
    )

    if (!built.success)
      return yield* Effect.die(
        new Error(
          `Building the chat pages failed: ${built.logs.map((log) => log.message).join("\n")}`,
        ),
      )

    for (const output of built.outputs)
      yield* router.add(
        "GET",
        `/${output.path.split("/").at(-1)}` as HttpRouter.PathInput,
        Effect.succeed(
          HttpServerResponse.text(yield* Effect.promise(() => output.text()), {
            contentType: "text/javascript; charset=utf-8",
          }),
        ),
      )

    for (const [path, file] of [
      ["/rooms/*", "index.html"],
      ["/react/rooms/*", "react.html"],
      ["/offline/rooms/*", "offline.html"],
      ["/cursors/*", "cursors.html"],
      ["/react/cursors/*", "cursors-react.html"],
    ] as const)
      yield* router.add(
        "GET",
        path,
        Effect.succeed(
          HttpServerResponse.text(
            yield* Effect.promise(() => Bun.file(`${import.meta.dir}/${file}`).text()),
            { contentType: "text/html; charset=utf-8" },
          ),
        ),
      )

    yield* router.add("GET", "/health", Effect.succeed(HttpServerResponse.text("ok")))
  }),
)

const database = Layer.unwrap(
  Effect.map(
    Config.option(Config.Redacted("DATABASE_URL")),
    Option.match({ onNone: () => Database.pglite(), onSome: (url) => Database.postgres({ url }) }),
  ),
)

HttpRouter.serve(Layer.mergeAll(api, pages)).pipe(
  Layer.provide(served),
  Layer.provide(database),
  Layer.provide(BunCrypto.layer),
  Layer.provide(BunHttpServer.layerConfig({ port: Config.withDefault(Config.Int("PORT"), 3003) })),
  Layer.launch,
  BunRuntime.runMain,
)
