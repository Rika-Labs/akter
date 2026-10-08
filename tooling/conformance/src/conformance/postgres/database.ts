import {
  Crypto,
  Data,
  Effect,
  Exit,
  ManagedRuntime,
  Redacted,
  Schedule,
  Schema,
  Scope,
} from "effect"
import type { Config } from "effect"
import { Pool } from "pg"
import type { ConformanceBackend, ConformanceDatabase } from "../../conformance.ts"
import { disposableDatabase } from "../../../../../packages/akter/src/testing/database.ts"
import { cryptoLayer, httpServerLayer } from "../platform.ts"

const harness = ManagedRuntime.make(cryptoLayer)

/** Database creation on the primary has not reached the asynchronous standby yet. */
class ReplicaDatabasePending extends Data.TaggedError("ReplicaDatabasePending")<{
  readonly cause: unknown
}> {}

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
  /**
   * The server lets the suite create databases beside its main one. A Neki
   * router does not, so cases that open fresh databases or snapshots skip.
   */
  readonly freshDatabases?: boolean
  /**
   * The suite's main database is the one `url` names, created and dropped by
   * whoever runs the suite, instead of a disposable one beside it. A Neki
   * router refuses `DROP DATABASE ... WITH (FORCE)`, so a disposable database
   * could not be dropped while its sessions linger.
   */
  readonly ownDatabase?: boolean
}

/**
 * The conformance backend for a Postgres-protocol server: each suite gets its
 * own disposable databases on it, dropped together when the suite closes.
 * Databases created on the primary replicate, so a replica serves each under
 * the same name. A template copy is a whole-database snapshot of a stopped
 * deployment; a disposed runtime's server sessions can outlive its pool
 * briefly, and Postgres refuses to copy a database with sessions. A replica
 * control connection waits for the newly created database to exist, because
 * asynchronous replay need not have applied its creation when the primary
 * returns; later control queries and their replay checks are never retried.
 */
export const postgresBackend = (options: PostgresBackendOptions): ConformanceBackend => ({
  independentConnections: true,
  hasReplica: options.replicaUrl !== undefined,
  neki: options.neki === true,
  logicalDecoding: options.logicalDecoding === true,
  freshDatabases: options.freshDatabases !== false,
  services: cryptoLayer,
  httpServer: httpServerLayer,
  open: () =>
    harness.runPromise(
      Effect.gen(function* () {
        const url = Redacted.make(yield* options.url)
        const crypto = yield* Crypto.Crypto
        const scope = yield* Scope.make("parallel")

        const provision = (prefix: "actors" | "isolated" | "restored", template?: string) =>
          disposableDatabase({ url, prefix, template }).pipe(
            Scope.provide(scope),
            Effect.provideService(Crypto.Crypto, crypto),
          )

        const main =
          options.ownDatabase === true ? url : yield* provision("actors", options.template?.())

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
          const replicaUrl = new URL(options.replicaUrl!)
          replicaUrl.pathname = new URL(Redacted.value(database)).pathname

          return Redacted.make(replicaUrl.href)
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
                  Effect.tap((pool) =>
                    Effect.tryPromise({
                      try: () => pool.query("SELECT 1"),
                      catch: (cause) => {
                        if (Schema.is(Schema.Struct({ code: Schema.Literal("3D000") }))(cause))
                          return new ReplicaDatabasePending({ cause })
                        throw cause
                      },
                    }).pipe(
                      Effect.retry({
                        schedule: Schedule.spaced("25 millis"),
                        times: 400,
                      }),
                      Effect.orDie,
                    ),
                  ),
                  Effect.map((pool) => ({
                    query: (statement: string, parameters?: ReadonlyArray<unknown>) =>
                      Effect.promise(() =>
                        pool.query(statement, parameters as Array<unknown> | undefined),
                      ).pipe(Effect.map((result) => result.rows as ReadonlyArray<unknown>)),
                  })),
                ),
              }

        return {
          database: main,
          freshDatabase: provision("isolated"),
          copy: (database: ConformanceDatabase) =>
            Redacted.isRedacted(database)
              ? provision("restored", new URL(Redacted.value(database)).pathname.slice(1))
              : Effect.die(new Error("The Postgres backend copies only Postgres databases")),
          connect,
          replica,
          close: Scope.close(scope, Exit.void),
        }
      }),
    ),
})
