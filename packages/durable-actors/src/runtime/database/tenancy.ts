import { Context, Effect, Option } from "effect"
import { SqlClient } from "effect/sql"

/**
 * The role tenant-scoped transactions run as when row-level security is on.
 * Undefined, they run as the connecting role, which the policies exempt.
 */
export const TenantScope = Context.Reference<{
  readonly role: string | undefined
  readonly adoption: AdoptionScope | undefined
}>("durable-actors/TenantScope", {
  defaultValue: () => ({ role: undefined, adoption: undefined }),
})

/**
 * The writer role a runtime takes for turns of actor types that own an
 * enforced adopted table, and the types that do. The turn binds the role and
 * its tenant together, as row-level security does, because the framework
 * tables' `durable_tenant` policies bind every role that does not bypass them. `enforced` fills as each
 * type registers, before any turn runs.
 */
export interface AdoptionScope {
  readonly role: string
  readonly enforced: Set<string>
}

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

/**
 * Runs `effect` in a transaction bound to `tenant` as `role`, or unchanged
 * when row-level security is off or `effect` already runs in a transaction,
 * such as a query's, that its caller bound.
 */
export const inTenant =
  ({
    sql,
    role,
    tenant,
  }: {
    readonly sql: SqlClient.SqlClient
    readonly role: string | undefined
    readonly tenant: string
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if (role === undefined) return yield* effect

      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) return yield* effect

      return yield* sql.withTransaction(
        sql`SELECT ${tenantSettings({ sql, role, tenant })}`.pipe(Effect.andThen(effect)),
      )
    })

/** `inTenant` with this runtime's role. */
export const withTenant =
  (tenant: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const { role } = yield* TenantScope
      const sql = yield* SqlClient.SqlClient

      return yield* inTenant({ sql, role, tenant })(effect)
    })

const refuse = (message: string) =>
  Effect.die(new Error(`Row-level security is misconfigured: ${message}`))

/**
 * Refuses to start unless `role` confines the runtime to one tenant per
 * transaction: it must be settable by this login, must not bypass the
 * policies, and must be able to write every framework table. Every
 * framework table with a `tenant_id` must carry the policy, including tables
 * later migrations add. Every inspection view must belong to a view-owner
 * role the policies bind, so the views filter by the reader's tenant, and
 * which `role` can't act as, so a turn can't alter or drop a view. Setting
 * the role in a transaction is the one proof that works for every membership
 * rule.
 */
export const checkRowLevelSecurity = Effect.fnUntraced(function* (role: string) {
  const sql = yield* SqlClient.SqlClient

  const [found] = yield* sql<{ exempt: boolean }>`
    SELECT rolsuper OR rolbypassrls AS exempt FROM pg_roles WHERE rolname = ${role}`

  if (found === undefined) return yield* refuse(`role ${role} does not exist`)

  if (found.exempt)
    return yield* refuse(`role ${role} is a superuser or bypasses row-level security`)

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
      AND (c.relname LIKE 'actor\\_%' OR c.relname LIKE 'tenant\\_content%')
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

  const views = yield* sql<{
    view: string
    owner: string
    exempt: boolean
    shared: boolean
    readable: boolean
  }>`
    SELECT v.relname AS view, o.rolname AS owner,
      o.rolsuper OR o.rolbypassrls OR EXISTS (
        SELECT 1 FROM pg_class t
        WHERE t.relnamespace = current_schema()::regnamespace AND t.relkind = 'r'
          AND t.relrowsecurity AND pg_has_role(o.oid, t.relowner, 'USAGE')
      ) AS exempt,
      pg_has_role(${role}, o.oid, 'MEMBER') AS shared,
      NOT EXISTS (
        SELECT 1 FROM pg_class t
        WHERE t.relnamespace = current_schema()::regnamespace AND t.relkind = 'r'
          AND t.relname LIKE 'actor\\_%'
          AND NOT has_table_privilege(o.oid, t.oid, 'SELECT')
      ) AS readable
    FROM pg_class v JOIN pg_roles o ON o.oid = v.relowner
    WHERE v.relnamespace = 'durable'::regnamespace AND v.relkind = 'v'
    ORDER BY v.relname`

  for (const view of views) {
    if (view.exempt)
      return yield* refuse(
        `durable.${view.view} belongs to ${view.owner}, which the policies exempt, so it would show every tenant; give the views to a dedicated view-owner role`,
      )

    if (view.shared)
      return yield* refuse(
        `durable.${view.view} belongs to ${view.owner}, which ${role} can act as, so a turn could alter or drop it; give the views to a role ${role} is not a member of`,
      )

    if (!view.readable)
      return yield* refuse(
        `durable.${view.view} belongs to ${view.owner}, which cannot read every actor_* table; grant it SELECT`,
      )
  }
})

/**
 * Refuses an owned table that would let a tenant-scoped transaction see other
 * tenants' rows, or that `role` cannot use: row-level security must be on with
 * the `durable_tenant` policy its drizzle-kit migration creates, and `role`
 * must not own it, since Postgres exempts a table's owner from its policies.
 */
export const checkOwnedTable = Effect.fnUntraced(function* (
  schema: string,
  table: string,
  role: string,
) {
  const sql = yield* SqlClient.SqlClient

  const [found] = yield* sql<{ owned: boolean; protected: boolean; writable: boolean }>`
    SELECT pg_has_role(${role}, c.relowner, 'USAGE') AS owned,
      c.relrowsecurity AND EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'durable_tenant'
      ) AS protected,
      has_table_privilege(${role}, c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS writable
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = ${table}`

  if (found?.protected !== true)
    return yield* refuse(
      `owned table ${schema}.${table} has no durable_tenant policy; apply its drizzle-kit migration`,
    )

  if (found.owned)
    return yield* refuse(`role ${role} owns ${schema}.${table}, so no policy binds it`)

  if (!found.writable)
    return yield* refuse(`role ${role} cannot read and write ${schema}.${table}; grant it`)
})

/**
 * Refuses an adopted table `role` cannot use. An adopted table carries no
 * `durable_tenant` policy unless the application added one, so only the
 * privileges are checked: `role` reads it, and writes it when the runtime does.
 */
export const checkAdoptedTable = Effect.fnUntraced(function* (
  schema: string,
  table: string,
  role: string,
  writable: boolean,
) {
  const sql = yield* SqlClient.SqlClient

  const [found] = yield* sql<{ readable: boolean; writable: boolean }>`
    SELECT has_table_privilege(${role}, c.oid, 'SELECT') AS readable,
      has_table_privilege(${role}, c.oid, 'INSERT') AND has_table_privilege(${role}, c.oid, 'UPDATE')
        AND has_table_privilege(${role}, c.oid, 'DELETE') AS writable
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = ${table}`

  if (found?.readable !== true)
    return yield* refuse(`role ${role} cannot read ${schema}.${table}; grant it`)

  if (writable && !found.writable)
    return yield* refuse(`role ${role} cannot read and write ${schema}.${table}; grant it`)
})
