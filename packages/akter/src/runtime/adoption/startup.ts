import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { guardArguments, writeGrants } from "./enforce.ts"
import type { AdoptionTarget } from "./target.ts"

interface Trigger {
  readonly name: string
  readonly enabled: string
  readonly type: number
  readonly function: string
  readonly arguments: string
}

const GUARD_ROW_TYPE = 31

const GUARD_TRUNCATE_TYPE = 34

/**
 * Refuses an enforced table whose protection was changed behind the
 * runtime's back. `refuse` names the table and the fix. The guard triggers
 * must exist, be enabled always, and carry exactly the recorded writer,
 * allowed roles, columns, and actor type; no role but the writer and the
 * allowed ones may hold a write privilege, so a grant added later is caught
 * here and by the trigger.
 */
export const checkEnforcedTable = Effect.fnUntraced(function* ({
  target,
  writerRole,
  allowedRoles,
  runtimeRole,
  refuse,
}: {
  readonly target: Pick<
    AdoptionTarget,
    "schema" | "table" | "tenantColumn" | "actorColumn" | "actor"
  >
  readonly writerRole: string
  readonly allowedRoles: ReadonlyArray<string>
  readonly runtimeRole: string | undefined
  readonly refuse: (message: string) => Effect.Effect<never>
}) {
  const sql = yield* SqlClient.SqlClient

  if (runtimeRole === undefined)
    return yield* refuse(
      `is enforced for writer role ${writerRole}; start the runtime with adoption: { role: "${writerRole}" }`,
    )

  if (runtimeRole !== writerRole)
    return yield* refuse(
      `is enforced for writer role ${writerRole}, but the runtime takes ${runtimeRole}; set adoption.role to ${writerRole}`,
    )

  const triggers = yield* sql<Trigger>`
    SELECT t.tgname AS name, t.tgenabled AS enabled, t.tgtype::int AS type,
      p.proname AS function, encode(t.tgargs, 'escape') AS arguments
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = ${target.schema} AND c.relname = ${target.table} AND NOT t.tgisinternal
      AND t.tgname IN ('actor_adoption_guard', 'actor_adoption_guard_truncate')`

  const expected = guardArguments({ target, writerRole, allowedRoles })

  for (const [name, type] of [
    ["actor_adoption_guard", GUARD_ROW_TYPE],
    ["actor_adoption_guard_truncate", GUARD_TRUNCATE_TYPE],
  ] as const) {
    const found = triggers.find((trigger) => trigger.name === name)

    if (found === undefined)
      return yield* refuse(
        `is enforced but its guard trigger ${name} is missing; run akter adopt release ${target.table} --to observe and enforce it again`,
      )

    if (found.enabled !== "A")
      return yield* refuse(
        `is enforced but its guard trigger ${name} is not enabled always; run ALTER TABLE ${target.table} ENABLE ALWAYS TRIGGER ${name}`,
      )

    if (found.function !== "actor_adoption_guard" || found.type !== type)
      return yield* refuse(`is enforced but its trigger ${name} is not the framework guard`)

    if (found.arguments !== `${expected.join("\\000")}\\000`)
      return yield* refuse(
        `is enforced but its guard trigger ${name} does not carry the recorded writer, allowed roles, and columns`,
      )
  }

  const stray = (yield* writeGrants(target)).filter(
    (grant) => grant.grantee !== writerRole && !allowedRoles.includes(grant.grantee),
  )

  if (stray.length > 0)
    return yield* refuse(
      `is enforced but ${[...new Set(stray.map((grant) => grant.grantee))].join(", ")} hold write privileges again; revoke them (REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${target.table} FROM …)`,
    )
})

/**
 * Refuses a writer role a turn cannot run as: it must exist, this login must
 * be able to take it, and it must read and write every framework table and
 * every table in `tables` without owning one, because the whole turn runs as
 * the writer.
 */
export const checkWriterRole = Effect.fnUntraced(function* ({
  role,
  tables,
  refuse,
}: {
  readonly role: string
  readonly tables: ReadonlyArray<{ readonly schema: string; readonly table: string }>
  readonly refuse: (message: string) => Effect.Effect<never>
}) {
  const sql = yield* SqlClient.SqlClient

  const [found] = yield* sql<{ exists: boolean }>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS exists`

  if (found?.exists !== true) return yield* refuse(`writer role ${role} does not exist`)

  yield* sql`SELECT set_config('role', ${role}, true)`.pipe(
    sql.withTransaction,
    Effect.catch(() => refuse(`this login cannot SET ROLE ${role}`)),
  )

  const owned = yield* sql<{ schema: string; table: string; owned: boolean; usable: boolean }>`
    SELECT n.nspname AS schema, c.relname AS table,
      pg_has_role(${role}, c.relowner, 'USAGE') AS owned,
      has_table_privilege(${role}, c.oid, 'SELECT') AND has_table_privilege(${role}, c.oid, 'INSERT')
        AND has_table_privilege(${role}, c.oid, 'UPDATE') AND has_table_privilege(${role}, c.oid, 'DELETE') AS usable
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND (
      (n.oid = current_schema()::regnamespace AND (c.relname LIKE 'actor\\_%' OR c.relname LIKE 'tenant\\_content%'))
      OR (n.nspname, c.relname) IN (${sql.csv(tables.map(({ schema, table }) => sql`(${schema}, ${table})`))}))
    ORDER BY 1, 2`

  for (const table of owned) {
    if (table.owned)
      return yield* refuse(
        `writer role ${role} owns ${table.schema}.${table.table}; the writer must not own a table it is guarded on`,
      )

    if (!table.usable)
      return yield* refuse(
        `writer role ${role} cannot read and write ${table.schema}.${table.table}; grant it SELECT, INSERT, UPDATE, and DELETE`,
      )
  }
})
