import { Actor, User } from "@durable-actors/core"
import { Database, Inspector } from "@durable-actors/core/runtime"
import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
import { Console, Effect, Layer, Option, Schema } from "effect"
import type { Cause, Crypto } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import type { SqlClient } from "effect/unstable/sql"

import { UsageError, fail } from "../../failure.ts"
import { loadEntry } from "../workflows/check.ts"
import { pageRoutes } from "./inspector/page.ts"

const flags = {
  entry: Flag.File("entry", { mustExist: true }).pipe(
    Flag.withDescription("The entry module; it exports `app`, a Layer of its routes"),
  ),
  databaseUrl: Flag.Redacted("database-url").pipe(
    Flag.optional,
    Flag.withDescription("Run on this Postgres instead of PGlite"),
  ),
  dataDir: Flag.Directory("data-dir").pipe(
    Flag.optional,
    Flag.withDescription("Where PGlite keeps its files (default in memory)"),
  ),
  port: Flag.Int("port").pipe(
    Flag.filter(
      (port) => port >= 0 && port <= 65_535,
      () => "an integer 0-65535",
    ),
    Flag.withDefault(3000),
    Flag.withDescription("The port to listen on; 0 picks a free one (default 3000)"),
  ),
  hostname: Flag.String("hostname").pipe(
    Flag.withDefault("127.0.0.1"),
    Flag.withDescription("The address to listen on (default 127.0.0.1)"),
  ),
  tenant: Flag.String("tenant").pipe(
    Flag.withDefault("default"),
    Flag.withDescription("The one tenant the inspector reads (default default)"),
  ),
}

/** What `durable dev` provides to an entry's `app`: the database, crypto, and the router. */
export type DevServices = SqlClient.SqlClient | Crypto.Crypto | HttpRouter.HttpRouter

/**
 * An entry's `app` export: the application's routes, usually `Actor.serve`,
 * with its actor layers and `Actors.layer` provided, leaving the database to
 * `durable dev`. Its startup failures, such as a migration error, are tagged errors.
 */
export type DevApp = Layer.Layer<never, Cause.YieldableError, DevServices>

const isDevApp = (value: unknown): value is DevApp => Layer.isLayer(value)

const Entry = Schema.Struct({ app: Schema.declare(isDevApp) })

const decodeEntry = Schema.decodeUnknownEffect(Entry)

/** The `app` layer a loaded entry module exports. */
export const appOf = ({ module, entry }: { readonly module: object; readonly entry: string }) =>
  decodeEntry(module).pipe(
    Effect.map(({ app }) => app),
    Effect.mapError(() =>
      UsageError.make({
        message: `${entry} must export \`app\`: a Layer of its routes that needs only the database`,
      }),
    ),
  )

/** Where `durable dev` serves the inspector page; its API is under `/api`. */
export const INSPECTOR_PATH = "/_durable/inspector"

/**
 * The inspector's principal in `durable dev`: the developer who started it,
 * reading one tenant. The server listens on loopback unless told otherwise.
 */
export const localOperator = (tenant: string) =>
  Actor.auth.make(() => Effect.succeed({ tenant, caller: User.make({ subject: "durable-dev" }) }))

/** The entry's routes and the inspector's page and API, on one router. */
export const devRoutes = ({ app, tenant }: { readonly app: DevApp; readonly tenant: string }) =>
  Layer.mergeAll(
    app,
    Inspector.serve({ auth: localOperator(tenant), basePath: `${INSPECTOR_PATH}/api` }),
    pageRoutes(INSPECTOR_PATH),
  )

/**
 * `durable dev`: runs until interrupted, the entry's app and the inspector on
 * one server. The banner prints once the server listens, so `--port 0`
 * reports the port the server was given.
 */
export const devCommand = Command.make("dev", flags, (options) =>
  Effect.gen(function* () {
    if (Option.isSome(options.databaseUrl) && Option.isSome(options.dataDir))
      return yield* UsageError.make({
        message: "--data-dir is for PGlite; drop it or --database-url",
      })

    const module = yield* loadEntry(options.entry)
    const app = yield* appOf({ module, entry: options.entry })

    const database = Option.match(options.databaseUrl, {
      onNone: () =>
        Database.pglite(
          Option.match(options.dataDir, { onNone: () => ({}), onSome: (dataDir) => ({ dataDir }) }),
        ),
      onSome: (url) => Database.postgres({ url }),
    })

    const storage = Option.isSome(options.databaseUrl)
      ? "Postgres"
      : `PGlite (${Option.getOrElse(options.dataDir, () => "in memory")})`

    const banner = Layer.effectDiscard(
      HttpServer.addressFormattedWith((origin) =>
        Console.log(
          [
            `durable dev: ${options.entry} on ${storage}`,
            `  app        ${origin}`,
            `  inspector  ${origin}${INSPECTOR_PATH} (tenant ${options.tenant})`,
          ].join("\n"),
        ),
      ),
    )

    return Layer.mergeAll(
      HttpRouter.serve(devRoutes({ app, tenant: options.tenant })),
      banner,
    ).pipe(
      Layer.provide(BunHttpServer.layer({ port: options.port, hostname: options.hostname })),
      Layer.provide(database),
      Layer.provide(BunCrypto.layer),
    )
  }).pipe(
    Effect.flatMap(Layer.launch),
    Effect.catchTag("UsageError", (error) => fail({ message: error.message })),
  ),
).pipe(
  Command.withDescription(
    "Run the entry's app locally with a read-only inspector at /_durable/inspector",
  ),
)
