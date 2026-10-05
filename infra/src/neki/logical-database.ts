import { isResolved } from "alchemy/Diff"
import * as Provider from "alchemy/Provider"
import type { Resource } from "alchemy/Resource"
import { PgClient } from "@effect/sql-pg"
import { Effect, Layer, Redacted, Schedule, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
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
 * A logical database created with `CREATE DATABASE`, after which the deploy waits for every Neki
 * router to apply it, and dropped on delete. One that already exists under the name is adopted, so
 * a run that created it before its state write was lost converges instead of failing on the name.
 * A Neki router refuses `DROP DATABASE ... WITH (FORCE)`, so the drop is plain and only falls back
 * to forcing its sessions closed when the database is still in use, which only plain Postgres
 * allows. `CREATE DATABASE` copies `template1` and fails while any other session is in it, which
 * happens whenever two deploys create their databases on one cluster at once, so the create is
 * retried for up to two minutes while the template is in use. A router that refuses a statement
 * fails the deploy with its own error rather than falling back to another layout.
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

/** Waits until every router has applied the DDL this session's router has. */
const BARRIER =
  "SELECT __neki.wait_for_ddl(v.schema_version, v.cluster_version) FROM __neki.ddl_versions() v"

const isServerResponse = Schema.is(Schema.Struct({ code: Schema.String }))

/** SQLSTATE `55006`: the database, or the template a new one copies, still has sessions. */
const inUse = (error: SqlError.SqlError) =>
  isServerResponse(error.reason.cause) && error.reason.cause.code === "55006"

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
    const name = output?.name ?? olds.name
    return (yield* connected(olds.connectionUrl, exists(name))) ? { name } : undefined
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
        yield* sql`CREATE DATABASE ${sql(news.name)}`.pipe(
          Effect.retry({
            while: inUse,
            schedule: Schedule.min([
              Schedule.exponential("250 millis"),
              Schedule.spaced("5 seconds"),
            ]).pipe(Schedule.upTo({ duration: "2 minutes" })),
          }),
        )
        yield* sql.unsafe(BARRIER).pipe(Effect.ignore)
      }),
    )
    return { name: news.name }
  }),

  delete: Effect.fn(function* ({ olds, output }) {
    yield* connected(
      olds.connectionUrl,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DROP DATABASE IF EXISTS ${sql(output.name)}`.pipe(
          Effect.catchIf(
            inUse,
            () => sql`DROP DATABASE IF EXISTS ${sql(output.name)} WITH (FORCE)`,
          ),
        )
      }),
    )
  }),
})
