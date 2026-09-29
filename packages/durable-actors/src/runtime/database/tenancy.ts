import { Context, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

/**
 * The role tenant-scoped transactions run as when row-level security is on.
 * Undefined, they run as the connecting role, which the policies exempt.
 */
export const TenantScope = Context.Reference<{ readonly role: string | undefined }>(
  "durable-actors/TenantScope",
  { defaultValue: () => ({ role: undefined }) },
)

/**
 * The settings that bind the rest of a transaction to `tenant`: its role and
 * the `durable.tenant` setting every `durable_tenant` policy compares with.
 * Both are local, so they end with the transaction and never leak to the
 * next borrower of the connection.
 */
export const tenantSettings = ({
  sql,
  role,
  tenant,
}: {
  readonly sql: SqlClient.SqlClient
  readonly role: string
  readonly tenant: string
}) => sql`set_config('role', ${role}, true), set_config('durable.tenant', ${tenant}, true)`

/** Runs `effect` in a transaction bound to `tenant`, or unchanged when row-level security is off. */
export const withTenant =
  (tenant: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const { role } = yield* TenantScope

      if (role === undefined) return yield* effect

      const sql = yield* SqlClient.SqlClient

      return yield* sql.withTransaction(
        sql`SELECT ${tenantSettings({ sql, role, tenant })}`.pipe(Effect.andThen(effect)),
      )
    })

const refuse = (message: string) =>
  Effect.die(new Error(`Row-level security is misconfigured: ${message}`))

/**
 * Refuses to start unless `role` confines the runtime to one tenant per
 * transaction: it must be settable by this login, must not bypass the
 * policies, must be able to write every framework table, and must own every
 * inspection view, so the views filter by the reader's tenant too. Every
 * framework table with a `tenant_id` must carry the policy, including tables
 * later migrations add.
 */
export const checkRowLevelSecurity = Effect.fnUntraced(function* (role: string) {
  const sql = yield* SqlClient.SqlClient

  const [found] = yield* sql<{ exempt: boolean }>`
    SELECT rolsuper OR rolbypassrls AS exempt FROM pg_roles WHERE rolname = ${role}`

  if (found === undefined) return yield* refuse(`role ${role} does not exist`)

  if (found.exempt)
    return yield* refuse(`role ${role} is a superuser or bypasses row-level security`)

  // Taking the role is the one proof that works for every membership rule.
  yield* sql`SELECT set_config('role', ${role}, true)`.pipe(
    sql.withTransaction,
    Effect.catch(() => refuse(`this login cannot SET ROLE ${role}`)),
  )

  const tables = yield* sql<{
    table: string
    owned: boolean
    protected: boolean
    writable: boolean
  }>`
    SELECT c.relname AS table,
      pg_has_role(${role}, c.relowner, 'USAGE') AS owned,
      c.relrowsecurity AND EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'durable_tenant'
      ) AS protected,
      has_table_privilege(${role}, c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS writable
    FROM pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
      AND c.relname LIKE 'actor\\_%'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      )
    ORDER BY c.relname`

  for (const table of tables) {
    if (table.owned) return yield* refuse(`role ${role} owns ${table.table}, so no policy binds it`)

    if (!table.protected)
      return yield* refuse(`${table.table} has no durable_tenant policy; apply migration 0018_rls`)

    if (!table.writable)
      return yield* refuse(`role ${role} cannot read and write ${table.table}; grant it`)
  }

  const views = yield* sql<{ view: string }>`
    SELECT c.relname AS view FROM pg_class c
    WHERE c.relnamespace = 'durable'::regnamespace AND c.relkind = 'v'
      AND c.relowner <> ${role}::regrole
    ORDER BY c.relname`

  if (views.length > 0)
    return yield* refuse(
      `durable.${views[0]!.view} is not owned by ${role}, so it would show every tenant`,
    )
})

/**
 * Refuses an owned table that would let a tenant-scoped transaction see other
 * tenants' rows, or that `role` cannot use: row-level security must be on with
 * the `durable_tenant` policy its drizzle-kit migration creates.
 */
export const checkOwnedTable = Effect.fnUntraced(function* (
  schema: string,
  table: string,
  role: string,
) {
  const sql = yield* SqlClient.SqlClient

  const [found] = yield* sql<{ protected: boolean; writable: boolean }>`
    SELECT c.relrowsecurity AND EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'durable_tenant'
      ) AS protected,
      has_table_privilege(${role}, c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS writable
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = ${table}`

  if (found?.protected !== true)
    return yield* refuse(
      `owned table ${schema}.${table} has no durable_tenant policy; apply its drizzle-kit migration`,
    )

  if (!found.writable)
    return yield* refuse(`role ${role} cannot read and write ${schema}.${table}; grant it`)
})
