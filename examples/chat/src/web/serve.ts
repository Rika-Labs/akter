// The chat room served to a browser: Actor.serve under /api and the page at
// /rooms/<id>?user=<name>. PGlite in memory unless DATABASE_URL names Postgres.
//   bun run web            # http://localhost:3003/rooms/lobby?user=alice
import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Actor } from "@durable-actors/core"
import { Database } from "@durable-actors/core/runtime"
import { Config, Effect, Layer, Option, Redacted } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { actors } from "../app.ts"
import { Room } from "../room/contract.ts"
import { demoAuth } from "../server.ts"

const api = Actor.serve({ actors: [Room], auth: demoAuth, basePath: "/api" })

// The page's script, bundled for browsers from app.ts once at startup.
const page = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const built = yield* Effect.promise(() =>
      Bun.build({ entrypoints: [`${import.meta.dir}/app.ts`], target: "browser", minify: true }),
    )

    if (!built.success || built.outputs[0] === undefined)
      return yield* Effect.die(
        new Error(
          `Building the chat page failed: ${built.logs.map((log) => log.message).join("\n")}`,
        ),
      )

    const script = yield* Effect.promise(() => built.outputs[0]!.text())
    const html = yield* Effect.promise(() => Bun.file(`${import.meta.dir}/index.html`).text())
    const document = HttpServerResponse.text(html, { contentType: "text/html; charset=utf-8" })

    yield* router.add(
      "GET",
      "/app.js",
      Effect.succeed(
        HttpServerResponse.text(script, { contentType: "text/javascript; charset=utf-8" }),
      ),
    )
    yield* router.add("GET", "/rooms/*", Effect.succeed(document))
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

HttpRouter.serve(Layer.mergeAll(api, page)).pipe(
  Layer.provide(actors),
  Layer.provide(database),
  Layer.provide(BunCrypto.layer),
  Layer.provide(port),
  Layer.launch,
  BunRuntime.runMain,
)
