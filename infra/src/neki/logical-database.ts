import { isResolved } from "alchemy/Diff"
import * as Provider from "alchemy/Provider"
import type { Resource } from "alchemy/Resource"
import { PgClient } from "@effect/sql-pg"
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import type { Providers } from "./providers.ts"
import { Neki } from "./resources.ts"

/**
 * Properties of a logical Postgres database inside a Neki cluster. The cluster and its roles
 * belong to PlanetScale's API; a logical database does not, so this resource connects as a role
 * that may create databases and issues the statements itself.
 */
export interface NekiLogicalDatabaseProps {
  /** Lowercase database name, at most 63 characters. Changing it replaces the database. */
  name: string
  /** The connection URL of a role that inherits `postgres`, usually `Neki.Role`'s `connectionUrl`. */
  connectionUrl: Redacted.Redacted<string>
}

export interface NekiLogicalDatabaseAttributes {
  name: string
}

/**
 * A logical database created with `CREATE DATABASE` and dropped, with its connections, on delete.
 * Whether a Neki router accepts these statements has no provider evidence yet; the resource
 * fails the deploy with the router's own error rather than falling back to another layout.
 *
 * @example
 * ```typescript
 * const database = yield* Neki.LogicalDatabase("Preview", {
 *   name: "akter_pr_12",
 *   connectionUrl: admin.connectionUrl,
 * })
 * ```
 */
export type NekiLogicalDatabase = Resource<
  "Planetscale.NekiLogicalDatabase",
  NekiLogicalDatabaseProps,
  NekiLogicalDatabaseAttributes,
  never,
  Providers
>

const NAME = /^[a-z][a-z0-9_]{0,62}$/

const connected = <A, E>(
  url: Redacted.Redacted<string>,
  statements: Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(PgClient.layer({ url, maxConnections: 1 }))
    return yield* Effect.provideContext(statements, context)
  }).pipe(Effect.scoped, Effect.orDie)

const exists = Effect.fn(function* (name: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT 1 FROM pg_database WHERE datname = ${name}`
  return rows.length > 0
})

export const NekiLogicalDatabaseProvider = Provider.succeed(Neki.LogicalDatabase, {
  stables: ["name"],

  diff: ({ news, output }) =>
    Effect.succeed(
      isResolved(news) && output !== undefined && news.name !== output.name
        ? ({ action: "replace" } as const)
        : undefined,
    ),

  read: Effect.fn(function* ({ olds, output }) {
    if (output === undefined) return undefined
    return (yield* connected(olds.connectionUrl, exists(output.name))) ? output : undefined
  }),

  reconcile: Effect.fn(function* ({ news }) {
    if (!NAME.test(news.name))
      return yield* Effect.die(
        new Error(`"${news.name}" is not a lowercase Postgres database name`),
      )
    yield* connected(
      news.connectionUrl,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        if (yield* exists(news.name)) return
        yield* sql`CREATE DATABASE ${sql(news.name)}`
        yield* sql`SELECT __neki.wait_for_ddl()`.pipe(Effect.ignore)
      }),
    )
    return { name: news.name }
  }),

  delete: Effect.fn(function* ({ olds, output }) {
    yield* connected(
      olds.connectionUrl,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DROP DATABASE IF EXISTS ${sql(output.name)} WITH (FORCE)`
      }),
    )
  }),
})
