import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
import { Crypto, Effect, Layer, ManagedRuntime, Redacted, Schedule } from "effect"
import type { Config } from "effect"
import { Pool } from "pg"
import type { ConformanceBackend, ConformanceDatabase } from "../../conformance.ts"

/** Postgres refuses to copy a database while a session is open on its source, and the server ends a closed pool's sessions a moment after the client has, so template copies retry. */
const copyDatabase = (admin: Pool, name: string, template: string) =>
  Effect.tryPromise(() => admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`)).pipe(
    Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
  )

const createDatabase = Effect.fnUntraced(function* (
  crypto: Crypto.Crypto,
  admin: Pool,
  base: URL,
  prefix: string,
  template?: string,
) {
  const name = `${prefix}_${(yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")}`

  if (template === undefined) yield* Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`))
  else yield* copyDatabase(admin, name, template).pipe(Effect.orDie)
  const database = new URL(base.href)
  database.pathname = `/${name}`

  return { name, url: database.href }
})

const harness = ManagedRuntime.make(BunCrypto.layer)

export interface PostgresBackendOptions {
  /** The server's connection string; each suite creates databases on it. */
  readonly url: Effect.Effect<string, Config.ConfigError>
  /** A migrated database the suite's main database is copied from, when the run made one. */
  readonly template?: () => string | undefined
  /** A physical streaming replica of the server, when one is configured. */
  readonly replicaUrl?: string | undefined
  /** The server is a Neki router: turn sessions run single, and the Neki cases run. */
  readonly neki?: boolean
  /** The server runs `wal_level=logical`, so the fleet cases run. */
  readonly logicalDecoding?: boolean
}

/**
 * The conformance backend for a Postgres-protocol server: each suite gets its
 * own databases on it, and the backend drops them when the suite closes.
 * Databases created on the primary replicate, so a replica serves each under
 * the same name. A template copy is a whole-database snapshot of a stopped
 * deployment; a disposed runtime's server sessions can outlive its pool
 * briefly, and Postgres refuses to copy a database with sessions.
 */
export const postgresBackend = (options: PostgresBackendOptions): ConformanceBackend => ({
  independentConnections: true,
  hasReplica: options.replicaUrl !== undefined,
  neki: options.neki === true,
  logicalDecoding: options.logicalDecoding === true,
  services: BunCrypto.layer,
  httpServer: Layer.orDie(BunHttpServer.layerServer({ hostname: "127.0.0.1", port: 0 })),
  open: () =>
    harness.runPromise(
      Effect.gen(function* () {
        const base = new URL(yield* options.url)
        const crypto = yield* Crypto.Crypto
        const admin = new Pool({ connectionString: base.href })
        const created: Array<string> = []

        const provision = Effect.fnUntraced(function* (prefix: string, template?: string) {
          const database = yield* createDatabase(crypto, admin, base, prefix, template)
          created.push(database.name)

          return Redacted.make(database.url)
        })

        const main = yield* provision("actors", options.template?.())

        const connect = Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: Redacted.value(main) })),
          (pool) => Effect.promise(() => pool.end()),
        ).pipe(
          Effect.andThen((pool) =>
            Effect.acquireRelease(
              Effect.promise(() => pool.connect()),
              (client) =>
                Effect.promise(() => client.query("ROLLBACK")).pipe(
                  Effect.andThen(Effect.sync(() => client.release())),
                ),
            ),
          ),
          Effect.map((client) => ({
            query: (statement: string, parameters?: ReadonlyArray<unknown>) =>
              Effect.promise(() =>
                client.query(statement, parameters as Array<unknown> | undefined),
              ).pipe(Effect.map((result) => result.rows as ReadonlyArray<unknown>)),
          })),
        )

        const onReplica = (database: Redacted.Redacted<string>) => {
          const url = new URL(options.replicaUrl!)
          url.pathname = new URL(Redacted.value(database)).pathname

          return Redacted.make(url.href)
        }

        const replica =
          options.replicaUrl === undefined
            ? undefined
            : {
                database: onReplica(main),
                connect: Effect.acquireRelease(
                  Effect.sync(
                    () => new Pool({ connectionString: Redacted.value(onReplica(main)) }),
                  ),
                  (pool) => Effect.promise(() => pool.end()),
                ).pipe(
                  Effect.map((pool) => ({
                    query: (statement: string, parameters?: ReadonlyArray<unknown>) =>
                      Effect.promise(() =>
                        pool.query(statement, parameters as Array<unknown> | undefined),
                      ).pipe(Effect.map((result) => result.rows as ReadonlyArray<unknown>)),
                  })),
                ),
              }

        const copy = Effect.fnUntraced(function* (database: Redacted.Redacted<string>) {
          const source = new URL(Redacted.value(database)).pathname.slice(1)
          const name = `restored_${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`

          yield* copyDatabase(admin, name, source)
          created.push(name)
          const url = new URL(base.href)
          url.pathname = `/${name}`

          return Redacted.make(url.href)
        }, Effect.orDie)

        return {
          database: main,
          freshDatabase: provision("isolated"),
          copy: (database: ConformanceDatabase) =>
            Redacted.isRedacted(database)
              ? copy(database)
              : Effect.die(new Error("The Postgres backend copies only Postgres databases")),
          connect,
          replica,
          close: Effect.gen(function* () {
            for (const name of created)
              yield* Effect.promise(() =>
                admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
              )
            yield* Effect.promise(() => admin.end())
          }),
        }
      }),
    ),
})
