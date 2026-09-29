/**
 * The chat room served to a browser: Actor.serve under /api, the page at
 * /rooms/<id>?user=<name>, and the same room with @durable-actors/react at
 * /react/rooms/<id>. PGlite in memory unless DATABASE_URL names Postgres.
 *   bun run web            # http://localhost:3003/rooms/lobby?user=alice
 */
import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Actor } from "@durable-actors/core"
import { Database } from "@durable-actors/core/runtime"
import { Config, Effect, Layer, Option, Redacted } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { actors } from "../app.ts"
import { Room } from "../room/contract.ts"
import { demoAuth } from "../server.ts"

const api = Actor.serve({ actors: [Room], auth: demoAuth, basePath: "/api" })

/**
 * The pages' scripts, bundled for browsers from app.ts and react.tsx once at
 * startup.
 */
const pages = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const built = yield* Effect.promise(() =>
      Bun.build({
        entrypoints: [`${import.meta.dir}/app.ts`, `${import.meta.dir}/react.tsx`],
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

    for (const output of built.outputs) {
      const script = yield* Effect.promise(() => output.text())

      yield* router.add(
        "GET",
        `/${output.path.split("/").at(-1)}` as HttpRouter.PathInput,
        Effect.succeed(
          HttpServerResponse.text(script, { contentType: "text/javascript; charset=utf-8" }),
        ),
      )
    }

    const page = (name: string) =>
      Effect.promise(() => Bun.file(`${import.meta.dir}/${name}`).text()).pipe(
        Effect.map((html) =>
          HttpServerResponse.text(html, { contentType: "text/html; charset=utf-8" }),
        ),
      )

    yield* router.add("GET", "/rooms/*", Effect.succeed(yield* page("index.html")))
    yield* router.add("GET", "/react/rooms/*", Effect.succeed(yield* page("react.html")))
    yield* router.add("GET", "/health", Effect.succeed(HttpServerResponse.text("ok")))
  }),
)

const database = Layer.unwrap(
  Effect.map(Config.option(Config.String("DATABASE_URL")), (url) =>
    Option.match(url, {
      onNone: () => Database.pglite(),
      onSome: (value) => Database.postgres({ url: Redacted.make(value) }),
    }),
  ),
)

const port = Layer.unwrap(
  Effect.map(Config.withDefault(Config.Int("PORT"), 3003), (value) =>
    BunHttpServer.layer({ port: value }),
  ),
)

HttpRouter.serve(Layer.mergeAll(api, pages)).pipe(
  Layer.provide(actors),
  Layer.provide(database),
  Layer.provide(BunCrypto.layer),
  Layer.provide(port),
  Layer.launch,
  BunRuntime.runMain,
)
