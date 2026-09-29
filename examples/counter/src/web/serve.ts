// The counter served to a browser: Actor.serve under /api, the page at
// /counters/<id>?user=<name>, and the same counter with @durable-actors/react
// at /react/counters/<id>. PGlite in memory unless DATABASE_URL names Postgres.
//   bun run web            # http://localhost:3004/counters/visits?user=alice
import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Actor, Unauthorized, User } from "@durable-actors/core"
import { Actors, Database } from "@durable-actors/core/runtime"
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Headers, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { Counter } from "../counter/contract.ts"
import { CounterLive } from "../counter/layer.ts"

// A stand-in for a real identity provider: the bearer token is the user's name. Use Actor.auth.jwt in production.
// A browser's WebSocket can't send headers, so a connection's `hello` frame carries it as `credential`.
const demoAuth = Actor.auth.make((request) =>
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

const api = Actor.serve({ actors: [Counter], auth: demoAuth, basePath: "/api" })

const actors = CounterLive.pipe(
  Layer.provideMerge(
    Actors.layer({
      authorize: ({ caller, ref }) =>
        Effect.succeed(Schema.is(User)(caller) && ref.tenant === "counter-demo"),
    }),
  ),
)

// The pages' scripts, bundled for browsers from app.ts and react.tsx once at startup.
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
          `Building the counter pages failed: ${built.logs.map((log) => log.message).join("\n")}`,
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

    yield* router.add("GET", "/counters/*", Effect.succeed(yield* page("index.html")))
    yield* router.add("GET", "/react/counters/*", Effect.succeed(yield* page("react.html")))
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
  Effect.map(Config.withDefault(Config.Int("PORT"), 3004), (value) =>
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
