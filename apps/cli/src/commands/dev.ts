import { pathToFileURL } from "node:url"
import { Config, Console, Context, Effect, Layer, Option, Path } from "effect"
import { HttpServer } from "effect/http"
import { Command, Flag } from "effect/cli"
import { Akter, App, Auth, RuntimeControl, Store, Telemetry } from "@rikalabs/akter/server"
import { fail } from "../failure.ts"

/** Runs a real filesystem-backed app; DevTools is an opt-in telemetry connection, never an unaudited inspector. */
export const devCommand = Command.make(
  "dev",
  {
    entry: Flag.String("entry").pipe(Flag.withDefault("src/app.ts")),
    dir: Flag.String("dir").pipe(Flag.withDefault(".akter/store")),
    port: Flag.Int("port").pipe(Flag.withDefault(8080)),
    devtools: Flag.Boolean("devtools").pipe(Flag.withDefault(false)),
    devtoolsUrl: Flag.String("devtools-url").pipe(Flag.withDefault("ws://localhost:34437")),
  },
  (options) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const loaded = yield* Effect.tryPromise(
        () => import(pathToFileURL(path.resolve(options.entry)).href),
      ).pipe(
        Effect.catch(() => fail({ reason: "InvalidApp", message: "Cannot load the app entry." })),
      )
      if (!App.is(loaded.default))
        return yield* fail({
          reason: "InvalidApp",
          message: "The entry must default-export App.make(...).",
        })
      const token = yield* Config.Redacted("AKTER_OPERATOR_TOKEN").pipe(Config.option)
      const { OperatorAuth } = yield* Effect.promise(() => import("@rikalabs/akter/server"))
      const operatorAuth = Option.isNone(token)
        ? undefined
        : OperatorAuth.tokens([
            {
              token: token.value,
              grant: {
                operator: "local-dev",
                capabilities: [
                  "inspect",
                  "log.read",
                  "snapshot.read",
                  "outcomes.read",
                  "audit.read",
                  "replay",
                ].map((action) => ({
                  action: action as
                    | "inspect"
                    | "log.read"
                    | "snapshot.read"
                    | "outcomes.read"
                    | "audit.read"
                    | "replay",
                  tenant: "default",
                })),
              },
            },
          ])
      const serving = Akter.serve({
        app: loaded.default,
        auth: Auth.none,
        hostname: "127.0.0.1",
        port: options.port,
        operatorAuth,
        prometheus: true,
      }).pipe(
        Layer.provide(Store.fileSystem(options.dir)),
        Layer.provide(
          Telemetry.layer(options.devtools ? { devtools: { url: options.devtoolsUrl } } : {}),
        ),
      )
      const context = yield* Layer.build(serving)
      const server = Context.get(context, HttpServer.HttpServer)
      const control = Context.get(context, RuntimeControl)
      yield* Effect.addFinalizer(() => Effect.asVoid(control.drain({ deadline: "5 seconds" })))
      yield* Console.log(
        `Akter dev on ${HttpServer.formatAddress(server.address)}; filesystem store ${options.dir}; operator access ${operatorAuth === undefined ? "disabled" : "enabled"}.`,
      )
      return yield* Effect.never
    }),
).pipe(
  Command.withDescription("Run a filesystem-backed app with optional Effect DevTools telemetry"),
)
