import { PgClient } from "@effect/sql-pg"
import {
  Clock,
  Config,
  Context,
  Crypto,
  Effect,
  Layer,
  Redacted,
  Schedule,
  type Scope,
} from "effect"
import { SqlClient } from "effect/unstable/sql"

/** A test database older than this belongs to no live run: runs are cut off well before it. */
const STALE_AFTER_MS = 60 * 60 * 1000

/** Test database names: a prefix, the creation time, and a random suffix. */
const NAMED = /^(?:actors|actors_template|isolated|restored|disposable)_(\d{13})_[0-9a-f]{32}$/

/**
 * A name for a test database that carries its creation time, so a later run
 * on a shared server can tell a leftover from a live run's database.
 */
export const databaseName = Effect.fnUntraced(function* (
  crypto: Crypto.Crypto,
  prefix: "actors" | "actors_template" | "isolated" | "restored" | "disposable",
) {
  const uuid = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")

  return `${prefix}_${yield* Clock.currentTimeMillis}_${uuid}`
})

/**
 * Runs `use` on an administrative connection to the server `url` names that
 * lives only as long as `use`. A connection held across a caller's scope
 * would belong to the fiber that opened it, and a finalizer running after
 * that fiber ended would find it interrupted.
 */
const withAdmin = <A, E>(
  url: Redacted.Redacted<string>,
  use: (admin: SqlClient.SqlClient) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Layer.build(PgClient.layer({ url, maxConnections: 1 })).pipe(
      Effect.map((context) => Context.get(context, SqlClient.SqlClient)),
      Effect.flatMap(use),
    ),
  ).pipe(Effect.orDie)

/** `url` with its database replaced by `name`. */
const onDatabase = (url: Redacted.Redacted<string>, name: string) => {
  const database = new URL(Redacted.value(url))
  database.pathname = `/${name}`

  return Redacted.make(database.href)
}

/**
 * Creates a database on the Postgres server `url` names for the current
 * scope and drops it, ending its sessions, when the scope closes. With
 * `template` the database is a copy of that one. Postgres refuses to copy a
 * database while a session is open on it, and a closed pool's server
 * sessions outlive it briefly, so a copy retries.
 */
export const disposableDatabase = Effect.fnUntraced(function* (options: {
  readonly url: Redacted.Redacted<string>
  readonly prefix?: "actors" | "actors_template" | "isolated" | "restored" | "disposable"
  readonly template?: string | undefined
}): Effect.fn.Return<Redacted.Redacted<string>, never, Scope.Scope | Crypto.Crypto> {
  const name = yield* databaseName(yield* Crypto.Crypto, options.prefix ?? "disposable")

  yield* Effect.acquireRelease(
    options.template === undefined
      ? withAdmin(options.url, (admin) => admin.unsafe(`CREATE DATABASE "${name}"`))
      : withAdmin(options.url, (admin) =>
          admin
            .unsafe(`CREATE DATABASE "${name}" TEMPLATE "${options.template}"`)
            .pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })),
        ),
    () =>
      withAdmin(options.url, (admin) =>
        admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      ),
  )

  return onDatabase(options.url, name)
})

/**
 * Drops the test databases an earlier run left behind on the server `url`
 * names: a run that was killed, or whose teardown timed out, never dropped
 * its own.
 */
export const sweepStaleDatabases = (url: Redacted.Redacted<string>) =>
  withAdmin(url, (admin) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const rows = yield* admin<{ readonly datname: string }>`SELECT datname FROM pg_database`

      yield* Effect.forEach(
        rows
          .map(({ datname }) => datname)
          .filter((name) => {
            const created = NAMED.exec(name)?.[1]

            return created !== undefined && now - Number(created) > STALE_AFTER_MS
          }),
        (name) => admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
        { concurrency: "unbounded", discard: true },
      )
    }),
  )

/**
 * The database a test that runs on both backends uses: `undefined`, a fresh
 * in-memory PGlite for each `ActorTest.layer` build, when `TEST_BACKEND` is
 * `pglite`, and otherwise a disposable database on the server
 * `TEST_DATABASE_URL` names, dropped when the scope closes.
 */
export const testDatabase: Effect.Effect<
  Redacted.Redacted<string> | undefined,
  Config.ConfigError,
  Scope.Scope | Crypto.Crypto
> = Effect.gen(function* () {
  if ((yield* Config.Literals(["pglite", "postgres"], "TEST_BACKEND")) === "pglite")
    return undefined

  return yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
})
