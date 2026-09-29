import { Actor, User } from "@durable-actors/core"
import { Inspector } from "@durable-actors/core/runtime"
import { Effect, Layer, Schema } from "effect"
import type { Cause, Crypto } from "effect"
import type { HttpRouter } from "effect/unstable/http"
import type { SqlClient } from "effect/unstable/sql"

import { UsageError } from "../workflows/check.ts"
import { pageRoutes } from "./inspector/page.ts"

/** Usage text for `durable dev`. */
export const USAGE =
  "Usage: durable dev --entry <module> [--database-url <url> | --data-dir <dir>] [--port <port>] [--hostname <host>] [--tenant <tenant>]"

/** Parsed arguments of `dev`. */
export interface DevOptions {
  readonly entry: string
  /** Postgres to run on; PGlite when absent. */
  readonly databaseUrl: string | undefined
  /** Where PGlite keeps its files; in memory when absent. */
  readonly dataDir: string | undefined
  readonly port: number
  readonly hostname: string
  /** The one tenant the inspector reads. */
  readonly tenant: string
}

const Port = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 65_535 }),
)

const decodePort = Schema.decodeUnknownEffect(Port)

const VALUED = new Set([
  "--entry",
  "--database-url",
  "--data-dir",
  "--port",
  "--hostname",
  "--tenant",
])

/** Parses the arguments after `dev`. */
export const parseDev = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const values = new Map<string, string>()

    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!

      if (!VALUED.has(arg)) return yield* UsageError.make({ message: `Unknown argument: ${arg}` })

      const value = args[++index]

      if (value === undefined) return yield* UsageError.make({ message: `${arg} needs a value` })

      values.set(arg, value)
    }

    const entry = values.get("--entry")

    if (entry === undefined) return yield* UsageError.make({ message: "--entry is required" })

    const databaseUrl = values.get("--database-url")
    const dataDir = values.get("--data-dir")

    if (databaseUrl !== undefined && dataDir !== undefined)
      return yield* UsageError.make({
        message: "--data-dir is for PGlite; drop it or --database-url",
      })

    const port = yield* decodePort(values.get("--port") ?? "3000").pipe(
      Effect.mapError(() => UsageError.make({ message: "--port must be an integer 0-65535" })),
    )

    return {
      entry,
      databaseUrl,
      dataDir,
      port,
      hostname: values.get("--hostname") ?? "127.0.0.1",
      tenant: values.get("--tenant") ?? "default",
    } satisfies DevOptions
  })

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
