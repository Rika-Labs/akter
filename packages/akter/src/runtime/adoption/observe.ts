import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/sql"
import { mappingProblems, quotedTable } from "./plan.ts"
import { AdoptionRefused, adoptionTargets, qualifiedName, type AdoptionTarget } from "./target.ts"

/** One legacy or runtime writer the observing trigger recorded, grouped as `observe --report` prints it. */
export interface ObservedWriter {
  readonly table: string
  readonly sessionUser: string
  readonly applicationName: string
  readonly operation: string
  /** True for statements a runtime turn made; the setting that marks them is forgeable, so it classifies and never authorizes. */
  readonly inTurn: boolean
  readonly allowed: boolean
  readonly statements: number
  readonly rows: number
  readonly firstSeenMs: number
  readonly lastSeenMs: number
}

const observeFunction = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  return (yield* sql<{ name: string }>`SELECT quote_ident(current_schema()) AS name`)[0]!.name
})

/**
 * Installs the four observing triggers on `target`, replacing any this module
 * installed before. `arguments` is empty while observing, and names the writer
 * and allowed roles once the table is enforced, so the trigger stays quiet for
 * the runtime and marks allowed roles.
 */
export const installObserveTriggers = Effect.fnUntraced(function* (
  target: AdoptionTarget,
  roles: ReadonlyArray<string> = [],
) {
  const sql = yield* SqlClient.SqlClient
  const schema = yield* observeFunction
  const table = quotedTable(target)

  const literals = roles.map((role) => `'${role.replaceAll("'", "''")}'`).join(", ")

  for (const event of ["insert", "update", "delete", "truncate"])
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS actor_adoption_observe_${event} ON ${table}`)

  const trigger = `${schema}.actor_adoption_observe(${literals})`

  yield* sql.unsafe(
    `CREATE TRIGGER actor_adoption_observe_insert AFTER INSERT ON ${table}
     REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION ${trigger}`,
  )
  yield* sql.unsafe(
    `CREATE TRIGGER actor_adoption_observe_update AFTER UPDATE ON ${table}
     REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
     FOR EACH STATEMENT EXECUTE FUNCTION ${trigger}`,
  )
  yield* sql.unsafe(
    `CREATE TRIGGER actor_adoption_observe_delete AFTER DELETE ON ${table}
     REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION ${trigger}`,
  )
  yield* sql.unsafe(
    `CREATE TRIGGER actor_adoption_observe_truncate AFTER TRUNCATE ON ${table}
     FOR EACH STATEMENT EXECUTE FUNCTION ${trigger}`,
  )
})

/** Refuses a `--table` filter that names a table adopted for reading only, which has no observing state. */
const writable = (targets: ReadonlyArray<AdoptionTarget>, only: string | undefined) => {
  const found = targets.filter((target) => target.access === "write")

  if (found.length === 0 && only !== undefined)
    return Effect.fail(
      AdoptionRefused.make({
        message: `${only} is adopted for reading only: nothing writes it, so it has no observing state`,
      }),
    )

  return Effect.succeed(found)
}

/**
 * Moves each writable adopted table of `actors` into the observing state:
 * adds the nullable `routing_key`, records the adoption, and installs the
 * statement triggers that record every later write. Observing changes no
 * outcome, and repeating it is safe. A table already enforced is refused.
 */
export const observeAdoption = Effect.fnUntraced(function* (
  actors: ReadonlyArray<WeakKey>,
  only?: string,
  lockTimeoutMs = 5000,
) {
  const sql = yield* SqlClient.SqlClient
  const done: Array<string> = []

  for (const target of yield* adoptionTargets(actors, only).pipe(
    Effect.flatMap((targets) => writable(targets, only)),
  )) {
    const name = qualifiedName(target)
    const problems = yield* mappingProblems(target)

    if (problems.length > 0)
      return yield* AdoptionRefused.make({
        message: `${name} cannot be adopted: ${problems.join("; ")}`,
      })

    yield* Effect.gen(function* () {
      yield* sql`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`

      const [existing] = yield* sql<{ actor_type: string; mode: string }>`
        SELECT actor_type, mode FROM actor_adoptions
        WHERE table_schema = ${target.schema} AND table_name = ${target.table} FOR UPDATE`

      if (existing !== undefined && existing.actor_type !== target.actor)
        return yield* AdoptionRefused.make({
          message: `${name} is adopted by actor ${existing.actor_type}, not ${target.actor}`,
        })

      if (existing?.mode === "enforce")
        return yield* AdoptionRefused.make({
          message: `${name} is enforced; run akter adopt release ${target.table} --to observe first`,
        })

      const [column] = yield* sql<{ type: string }>`
        SELECT t.typname AS type FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_type t ON t.oid = a.atttypid
        WHERE n.nspname = ${target.schema} AND c.relname = ${target.table}
          AND a.attname = 'routing_key' AND NOT a.attisdropped`

      if (column !== undefined && column.type !== "int8")
        return yield* AdoptionRefused.make({
          message: `${name} already has a routing_key column of type ${column.type}; it must be bigint`,
        })

      yield* sql.unsafe(
        `ALTER TABLE ${quotedTable(target)} ADD COLUMN IF NOT EXISTS routing_key bigint`,
      )

      yield* sql`INSERT INTO actor_adoptions (table_schema, table_name, actor_type, tenant_column,
          actor_column, mode, changed_at_ms, changed_by)
        VALUES (${target.schema}, ${target.table}, ${target.actor}, ${target.tenantColumn},
          ${target.actorColumn}, 'observe', floor(extract(epoch FROM clock_timestamp()) * 1000),
          session_user)
        ON CONFLICT (table_schema, table_name) DO UPDATE SET
          changed_at_ms = CASE WHEN actor_adoptions.tenant_column = EXCLUDED.tenant_column
            AND actor_adoptions.actor_column = EXCLUDED.actor_column
            THEN actor_adoptions.changed_at_ms ELSE EXCLUDED.changed_at_ms END,
          tenant_column = EXCLUDED.tenant_column, actor_column = EXCLUDED.actor_column,
          changed_by = EXCLUDED.changed_by`

      yield* installObserveTriggers(target)
    }).pipe(sql.withTransaction)

    done.push(name)
  }

  return done
})

/**
 * The writers recorded for the adopted tables of `actors` since `sinceMs`,
 * grouped by table, login, application, and operation, with the runtime's own
 * turns kept apart. `clear` deletes exactly the rows it reports.
 */
export const adoptionWriters = Effect.fnUntraced(function* (
  actors: ReadonlyArray<WeakKey>,
  options: {
    readonly only?: string | undefined
    readonly sinceMs?: number | undefined
    readonly clear?: boolean | undefined
  },
) {
  const sql = yield* SqlClient.SqlClient
  const found: Array<ObservedWriter> = []

  for (const target of yield* adoptionTargets(actors, options.only).pipe(
    Effect.flatMap((targets) => writable(targets, options.only)),
  )) {
    const since = options.sinceMs ?? 0

    const rows = yield* sql<{
      session_user_name: string
      application_name: string
      operation: string
      in_turn: boolean
      allowed: boolean
      statements: string
      rows: string
      first_seen: string
      last_seen: string
    }>`
      SELECT session_user_name, application_name, operation, in_turn, allowed,
        count(*)::text AS statements, sum(rows)::text AS rows,
        min(observed_at_ms)::text AS first_seen, max(observed_at_ms)::text AS last_seen
      FROM actor_adoption_writes
      WHERE table_schema = ${target.schema} AND table_name = ${target.table}
        AND observed_at_ms >= ${since}
      GROUP BY session_user_name, application_name, operation, in_turn, allowed
      ORDER BY in_turn, session_user_name, application_name, operation`

    for (const row of rows)
      found.push({
        table: qualifiedName(target),
        sessionUser: row.session_user_name,
        applicationName: row.application_name,
        operation: row.operation,
        inTurn: row.in_turn,
        allowed: row.allowed,
        statements: Number(row.statements),
        rows: Number(row.rows),
        firstSeenMs: Number(row.first_seen),
        lastSeenMs: Number(row.last_seen),
      })

    if (options.clear === true)
      yield* sql`DELETE FROM actor_adoption_writes
        WHERE table_schema = ${target.schema} AND table_name = ${target.table}
          AND observed_at_ms >= ${since}`
  }

  return found
})

/** One line of `observe --report`: who wrote, how often, and whether the runtime's own turns did. */
export const formatObservedWriter = (writer: ObservedWriter) =>
  `${writer.table}  ${writer.inTurn ? "turn " : writer.allowed ? "allow" : "legacy"}  ${writer.sessionUser}  ${writer.applicationName === "" ? "(no application_name)" : writer.applicationName}  ${writer.operation}  ${writer.statements} statements, ${writer.rows} rows  first ${DateTime.formatIso(DateTime.makeUnsafe(writer.firstSeenMs))}  last ${DateTime.formatIso(DateTime.makeUnsafe(writer.lastSeenMs))}`
