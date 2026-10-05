import { PgClient } from "@effect/sql-pg"
import { Context, Effect } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import type { SqlConnection, SqlError } from "effect/sql"
import type { Scope } from "effect"
import { Reactivity } from "effect/reactivity"
import { ShardingConfig } from "effect/cluster"
import { NekiTurnSessions } from "./session.ts"

/** Holds startup coordination before even the history table is created, on one leased session. */
export const withMigrationCoordination = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = yield* SqlClient.SqlClient
      const connection = yield* source.reserve
      yield* (yield* MigrationCoordination)(connection)
      const reactivity = yield* Reactivity.make
      const client = yield* SqlClient.make({
        acquirer: Effect.succeed(connection),
        compiler: PgClient.makeCompiler(),
        spanAttributes: [],
      }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity))
      return yield* Effect.provideService(effect, SqlClient.SqlClient, client)
    }),
  )

/** The schema and cluster catalog versions this session's router has applied, which every router must reach. */
export const NEKI_DDL_BARRIER =
  "SELECT __neki.wait_for_ddl(v.schema_version, v.cluster_version) FROM __neki.ddl_versions() v"

/**
 * Propagation must finish before a later statement uses the changed schema.
 * The router that ran the DDL reports its new versions at once; waiting for
 * them makes every other router apply that DDL too.
 */
export const MigrationBarrier = Context.Reference<
  (connection: SqlConnection.Connection) => Effect.Effect<unknown, SqlError.SqlError>
>("akter/MigrationBarrier", {
  defaultValue: () => (connection) => connection.execute(NEKI_DDL_BARRIER, [], undefined),
})

/** A reserved session owns coordination across autocommit DDL and progress writes. */
export const MigrationCoordination = Context.Reference<
  (connection: SqlConnection.Connection) => Effect.Effect<unknown, SqlError.SqlError, Scope.Scope>
>("akter/MigrationCoordination", {
  defaultValue: () => (connection) =>
    Effect.acquireRelease(
      connection.execute("SELECT pg_advisory_lock(1935764837, 487)", [], undefined),
      () =>
        connection
          .execute("SELECT pg_advisory_unlock(1935764837, 487)", [], undefined)
          .pipe(Effect.orDie),
    ),
})

/** Failure injection runs after a durable boundary, never in place of the database operation. */
export const MigrationBoundary = Context.Reference<(point: string) => Effect.Effect<void>>(
  "akter/MigrationBoundary",
  { defaultValue: () => () => Effect.void },
)

/** A preflight is already satisfied when this migration has started changing its schema. */
export const MigrationResuming = Context.Reference<boolean>("akter/MigrationResuming", {
  defaultValue: () => false,
})

/**
 * Cluster creates its tables outside migration history. Creating its default schema
 * under startup coordination first prevents concurrent CREATE races without lending
 * Cluster a migration-scoped SQL client or consuming a third off-turn connection.
 */
export const prepareRunnerStorage = Effect.gen(function* () {
  const config = yield* ShardingConfig.ShardingConfig
  const neki = yield* NekiTurnSessions
  return yield* withMigrationCoordination(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const connection = yield* sql.reserve
      const boundary = yield* MigrationBoundary
      const barrier = yield* MigrationBarrier
      if (neki) yield* barrier(connection)
      yield* sql`CREATE TABLE IF NOT EXISTS cluster_runners (
      machine_id SERIAL PRIMARY KEY,
      address VARCHAR(255) NOT NULL,
      runner TEXT NOT NULL,
      healthy BOOLEAN NOT NULL DEFAULT TRUE,
      last_heartbeat TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(address)
    )`
      yield* boundary("cluster:runners:ddl")
      if (neki) yield* barrier(connection)
      yield* boundary("cluster:runners:propagated")
      if (config.shardLockDisableAdvisory) {
        yield* sql`CREATE TABLE IF NOT EXISTS cluster_locks (
        shard_id VARCHAR(50) PRIMARY KEY,
        address VARCHAR(255) NOT NULL,
        acquired_at TIMESTAMP NOT NULL
      )`
        yield* boundary("cluster:locks:ddl")
        if (neki) yield* barrier(connection)
        yield* boundary("cluster:locks:propagated")
      }
    }),
  )
})

/** ALTER actions split only at commas outside quoted identifiers, literals and expressions. */
const alterActions = (text: string): ReadonlyArray<string> => {
  const actions: Array<string> = []
  let start = 0
  let depth = 0
  let quote = ""
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!
    if (quote !== "") {
      if (character === quote) {
        if (text[i + 1] === quote) i++
        else quote = ""
      }
    } else if (character === "'" || character === '"') quote = character
    else if (character === "(") depth++
    else if (character === ")") depth--
    else if (character === "," && depth === 0) {
      actions.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  actions.push(text.slice(start).trim())
  return actions
}

const identifier = '(?:"(?:[^"]|"")+"|[a-z_][a-z_0-9]*)(?:\\.(?:"(?:[^"]|"")+"|[a-z_][a-z_0-9]*))?'
const alter = new RegExp(`^ALTER TABLE (${identifier})\\s+([\\s\\S]+)$`, "i")
const unquote = (name: string) => name.replace(/^"|"$/g, "").replaceAll('""', '"')

/**
 * Resumption rewrites only the framework's audited DDL forms; an unknown form fails closed.
 * A statement that already carries its own existence guard is replayed unchanged.
 */
const replayDdl = (sql: SqlClient.SqlClient, text: string) =>
  Effect.gen(function* () {
    if (/^CREATE (?:UNIQUE )?(?:TABLE|INDEX|SCHEMA) /i.test(text))
      return text.replace(
        /^(CREATE (?:UNIQUE )?(?:TABLE|INDEX|SCHEMA)) (?!IF NOT EXISTS )/i,
        "$1 IF NOT EXISTS ",
      )
    if (/^DROP (?:TABLE|INDEX|VIEW) /i.test(text))
      return text.replace(/^(DROP (?:TABLE|INDEX|VIEW)) (?!IF EXISTS )/i, "$1 IF EXISTS ")
    if (/^REVOKE /i.test(text)) return text
    if (/^CREATE (?:OR REPLACE )?(?:VIEW|FUNCTION) /i.test(text))
      return text.replace(/^CREATE (?:OR REPLACE )?/i, "CREATE OR REPLACE ")

    const policy = new RegExp(`^CREATE POLICY (${identifier}) ON (${identifier})`, "i").exec(text)
    if (policy !== null) {
      const [row] = yield* sql<{ exists: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_policy WHERE polrelid = to_regclass(${policy[2]!})
          AND polname = ${unquote(policy[1]!)}) AS exists`
      return row?.exists === true ? undefined : text
    }

    const match = alter.exec(text)
    if (match !== null) {
      const table = match[1]!
      const action = match[2]!
      if (/^ADD COLUMN /i.test(action))
        return `ALTER TABLE ${table} ${action.replace(/^ADD COLUMN (?!IF NOT EXISTS )/i, "ADD COLUMN IF NOT EXISTS ")}`
      if (/^DROP CONSTRAINT /i.test(action))
        return `ALTER TABLE ${table} ${action.replace(/^DROP CONSTRAINT (?!IF EXISTS )/i, "DROP CONSTRAINT IF EXISTS ")}`
      if (/^ENABLE ROW LEVEL SECURITY$/i.test(action)) return text
      if (new RegExp(`^ALTER COLUMN ${identifier}\\s+SET DEFAULT\\s`, "i").test(action)) return text
      const constraint = new RegExp(`^ADD CONSTRAINT (${identifier})\\s+`, "i").exec(action)
      if (constraint !== null) {
        const [row] = yield* sql<{ exists: boolean }>`SELECT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(${table})
            AND conname = ${unquote(constraint[1]!)}) AS exists`
        return row?.exists === true ? undefined : text
      }
      const rename = new RegExp(`^RENAME COLUMN (${identifier}) TO (${identifier})$`, "i").exec(
        action,
      )
      if (rename !== null) {
        const rows = yield* sql<{ name: string }>`SELECT attname AS name FROM pg_attribute
          WHERE attrelid = to_regclass(${table}) AND NOT attisdropped
            AND attname IN (${unquote(rename[1]!)}, ${unquote(rename[2]!)})`
        if (rows.some(({ name }) => name === unquote(rename[1]!))) return text
        if (rows.some(({ name }) => name === unquote(rename[2]!))) return undefined
      }
    }
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: `No replay rule for migration DDL: ${text}`,
    })
  })

/**
 * DDL and its propagation run without BEGIN. A durable statement journal closes the
 * crash gap between applying DDL and recording it; replay touches only an unfinished
 * step, so a later drop/recreate cannot make an earlier create run again. Existing
 * data rewrites set fixed values and are replayable, never increments or external work.
 */
export const nekiMigrator = ({
  record,
  refuseSkipped,
}: {
  readonly record: Record<string, Effect.Effect<void, never, SqlClient.SqlClient>>
  readonly refuseSkipped: Effect.Effect<
    void,
    Migrator.MigrationError | SqlError.SqlError,
    SqlClient.SqlClient
  >
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = yield* SqlClient.SqlClient
      const connection = yield* source.reserve
      const barrier = yield* MigrationBarrier
      const boundary = yield* MigrationBoundary
      const reactivity = yield* Reactivity.make
      const direct = yield* SqlClient.make({
        acquirer: Effect.succeed(connection),
        compiler: PgClient.makeCompiler(),
        spanAttributes: [],
      }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity))

      for (const [name, ddl] of [
        [
          "history",
          "CREATE TABLE IF NOT EXISTS actor_migrations (migration_id integer PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), name text NOT NULL)",
        ],
        [
          "journal",
          "CREATE TABLE IF NOT EXISTS actor_migration_steps (migration_id integer NOT NULL, step integer NOT NULL, statement text NOT NULL, completed boolean NOT NULL DEFAULT false, PRIMARY KEY (migration_id, step))",
        ],
      ] as const) {
        yield* barrier(connection)
        yield* direct.unsafe(ddl)
        yield* boundary(`bootstrap:${name}:ddl`)
        yield* barrier(connection)
        yield* boundary(`bootstrap:${name}:propagated`)
      }

      yield* Effect.provideService(refuseSkipped, SqlClient.SqlClient, direct)
      const rows = yield* direct<{
        id: number
      }>`SELECT migration_id::int AS id FROM actor_migrations`
      const latest = Math.max(0, ...rows.map(({ id }) => id))
      const loaded = yield* Migrator.fromRecord(record)
      if (new Set(loaded.map(([id]) => id)).size !== loaded.length)
        return yield* new Migrator.MigrationError({
          kind: "Duplicates",
          message: "Found duplicate migration ids",
        })
      const applied: Array<readonly [number, string]> = []

      for (const [id, name] of loaded) {
        if (id <= latest) continue
        const [progress] = yield* direct<{ started: boolean }>`SELECT EXISTS (
      SELECT 1 FROM actor_migration_steps WHERE migration_id = ${id}) AS started`
        let step = 0
        const execute: SqlConnection.Connection["execute"] = (text, parameters, transform) =>
          Effect.gen(function* () {
            if (/^SELECT\b/i.test(text.trim()))
              return yield* connection.execute(text, parameters, transform)
            const mutation = text.trim()
            const ddl = /^(CREATE|ALTER|DROP|REVOKE)\b/i.test(mutation)
            if (!ddl && !(id === 26 && /^UPDATE\b/i.test(mutation)))
              return yield* Effect.die(
                new Migrator.MigrationError({
                  kind: "BadState",
                  message: `Migration ${id} has no replayable data step: ${mutation}`,
                }),
              )
            const alteration = alter.exec(mutation)
            const statements =
              alteration !== null
                ? alterActions(alteration[2]!).map(
                    (action) => `ALTER TABLE ${alteration[1]!} ${action}`,
                  )
                : [mutation]
            for (const statement of statements) {
              const position = ++step
              const point = `${id}:${position}`
              const [saved] = yield* direct<{
                statement: string
                completed: boolean
              }>`SELECT statement, completed
          FROM actor_migration_steps WHERE migration_id = ${id} AND step = ${position}`
              if (saved !== undefined && saved.statement !== statement)
                return yield* Effect.die(
                  new Migrator.MigrationError({
                    kind: "BadState",
                    message: `Migration ${point} changed after it started`,
                  }),
                )
              if (saved?.completed === true) continue
              if (saved === undefined) {
                yield* direct`INSERT INTO actor_migration_steps (migration_id, step, statement) VALUES (${id}, ${position}, ${statement})`
                yield* boundary(`${point}:pending`)
              }
              if (ddl) yield* barrier(connection)
              const replay = ddl
                ? yield* replayDdl(direct, statement).pipe(Effect.orDie)
                : statement
              if (replay !== undefined) yield* connection.execute(replay, parameters, transform)
              yield* boundary(`${point}:applied`)
              if (ddl) {
                yield* barrier(connection)
                yield* boundary(`${point}:propagated`)
              }
              yield* direct`UPDATE actor_migration_steps SET completed = true WHERE migration_id = ${id} AND step = ${position}`
              yield* boundary(`${point}:completed`)
            }
            return []
          })
        const client = yield* SqlClient.make({
          acquirer: Effect.succeed({ ...connection, execute }),
          compiler: PgClient.makeCompiler(),
          spanAttributes: [],
        }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity))
        yield* record[Object.keys(record).find((key) => Number(key.split("_")[0]) === id)!]!.pipe(
          Effect.provideService(SqlClient.SqlClient, client),
          Effect.provideService(MigrationResuming, progress?.started === true),
        )
        const [removed] = yield* direct<{ exists: boolean }>`SELECT EXISTS (
          SELECT 1 FROM actor_migration_steps WHERE migration_id = ${id} AND step > ${step}
        ) AS exists`
        if (removed?.exists === true)
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Migration ${id} removed steps after it started`,
          })
        yield* direct`INSERT INTO actor_migrations (migration_id, name) VALUES (${id}, ${name})`
        yield* boundary(`${id}:recorded`)
        applied.push([id, name])
      }
      yield* Effect.provideService(refuseSkipped, SqlClient.SqlClient, direct)
      return applied
    }),
  )
