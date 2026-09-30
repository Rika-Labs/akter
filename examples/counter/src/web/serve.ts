/**
 * The counter served to a browser: Actors.serve under /api, the page at
 * /counters/<id>?user=<name>, and the same counter with @durable-actors/react
 * at /react/counters/<id>. PGlite in memory unless DATABASE_URL names Postgres.
 *   bun run web            # http://localhost:3004/counters/visits?user=alice
 */
import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Unauthorized, User } from "@durable-actors/core"
import { Actors, Auth, Database } from "@durable-actors/core/runtime"
import { Config, Effect, Layer, Option } from "effect"
import { Headers, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { Counter } from "../counter/contract.ts"
import { CounterLive } from "../counter/layer.ts"

/**
 * A stand-in for a real identity provider: the bearer token is the user's name. Use Auth.jwt in production.
 * A browser's WebSocket can't send headers, so a connection's `hello` frame carries it as `credential`.
 */
const demoAuth = Auth.make((request) =>
  Option.match(
    request.credential === undefined
      ? Headers.get(request.headers, "authorization")
      : Option.some(request.credential),
    {
      onNone: () => Effect.fail(Unauthorized.make({ code: "missing_credentials" })),
      onSome: (header) => {
        const match = /^Bearer ([a-z0-9-]{1,64})$/.exec(header)

        return match === null
          ? Effect.fail(Unauthorized.make({ code: "invalid_credentials" }))
          : Effect.succeed({ tenant: "counter-demo", caller: User.make({ subject: match[1]! }) })
      },
    },
  ),
)

const api = Actors.serve({ actors: [Counter], auth: demoAuth, basePath: "/api" })

const actors = CounterLive.pipe(Layer.provideMerge(Actors.layer()))

/** The pages' scripts, bundled for browsers from their entry files once at startup, and their HTML. */
const pages = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const built = yield* Effect.promise(() =>
      Bun.build({
        entrypoints: ["app.ts", "react.tsx"].map((file) => `${import.meta.dir}/${file}`),
        target: "browser",
        minify: true,
      }),
    )

    if (!built.success)
      return yield* Effect.die(
        new Error(
          `Building the counter pages failed: ${built.logs.map((log) => log.message).join("\n")}`,
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
      ["/counters/*", "index.html"],
      ["/react/counters/*", "react.html"],
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
  Layer.provide(actors),
  Layer.provide(database),
  Layer.provide(BunCrypto.layer),
  Layer.provide(BunHttpServer.layerConfig({ port: Config.withDefault(Config.Int("PORT"), 3004) })),
  Layer.launch,
  BunRuntime.runMain,
)
