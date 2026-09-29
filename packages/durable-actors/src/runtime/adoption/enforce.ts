import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { installObserveTriggers } from "./observe.ts"
import { quotedTable } from "./plan.ts"
import { AdoptionRefused, adoptionTargets, qualifiedName, type AdoptionTarget } from "./target.ts"

/** The default window a table must have been observed and quiet for before it is enforced. */
export const DEFAULT_QUIET_MS = 7 * 86_400_000

const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const

const Revoked = Schema.Array(Schema.Struct({ grantee: Schema.String, privilege: Schema.String }))

const RevokedJson = Schema.fromJsonString(Revoked)

const decodeRevoked = Schema.decodeUnknownEffect(Revoked)

const encodeRevoked = Schema.encodeEffect(RevokedJson)

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

/** The grantees holding a write privilege on `target`, with the privilege, as the catalog records them. */
export const writeGrants = Effect.fnUntraced(function* (
  target: Pick<AdoptionTarget, "schema" | "table">,
) {
  const sql = yield* SqlClient.SqlClient

  return yield* sql<{ grantee: string; privilege: string }>`
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
      a.privilege_type AS privilege
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS a
    WHERE n.nspname = ${target.schema} AND c.relname = ${target.table}
      AND a.privilege_type IN ${sql.in(WRITE_PRIVILEGES)}
    ORDER BY 1, 2`
})

/** The trigger arguments the guard is installed with, in the order `actor_adoption_guard()` reads them. */
export const guardArguments = (
  target: Pick<AdoptionTarget, "tenantColumn" | "actorColumn" | "actor">,
  enforcement: { readonly writerRole: string; readonly allowedRoles: ReadonlyArray<string> },
) => [
  enforcement.writerRole,
  enforcement.allowedRoles.join(","),
  target.tenantColumn,
  target.actorColumn,
  target.actor,
]

const roleNamed = (name: string, flag: string) => {
  if (name === "" || name.includes(",") || name.includes("'"))
    return AdoptionRefused.make({ message: `${flag} names a role without commas or quotes` })

  return undefined
}

/**
 * The reasons `target` cannot be enforced yet, each naming the fix. Reads
 * only: a table is enforced when this is empty.
 */
const enforcementRefusals = Effect.fnUntraced(function* (
  target: AdoptionTarget,
  options: {
    readonly writerRole: string
    readonly allowedRoles: ReadonlyArray<string>
    readonly quietMs: number
    readonly nowMs: number
  },
) {
  const sql = yield* SqlClient.SqlClient
  const name = qualifiedName(target)
  const table = quotedTable(target)
  const refusals: Array<string> = []
  const allowed = [...options.allowedRoles]

  const [adoption] = yield* sql<{ changed_at_ms: string }>`
    SELECT changed_at_ms::text FROM actor_adoptions
    WHERE table_schema = ${target.schema} AND table_name = ${target.table}`

  const observedFor = options.nowMs - Number(adoption!.changed_at_ms)

  if (observedFor < options.quietMs)
    refusals.push(
      `${name} has been observed for ${Math.floor(observedFor / 1000)} s, less than the ${Math.floor(options.quietMs / 1000)} s quiet window (--quiet), so its silence proves nothing yet`,
    )

  const [counts] = yield* sql.unsafe<{ unfilled: string; unowned: string }>(
    `SELECT count(*) FILTER (WHERE routing_key IS NULL)::text AS unfilled,
       count(*) FILTER (WHERE ${identifier(target.tenantColumn)} IS NULL OR ${identifier(target.actorColumn)} IS NULL
         OR ${identifier(target.tenantColumn)}::text = '' OR ${identifier(target.actorColumn)}::text = '')::text AS unowned
     FROM ${table}`,
  )

  if (Number(counts!.unfilled) > 0)
    refusals.push(
      `${counts!.unfilled} rows of ${name} have no routing_key; run durable adopt backfill ${target.table}`,
    )

  if (Number(counts!.unowned) > 0)
    refusals.push(
      `${counts!.unowned} rows of ${name} have a NULL or empty ${target.tenantColumn} or ${target.actorColumn}, so no actor owns them`,
    )

  const recent = yield* sql<{
    session_user_name: string
    application_name: string
    operation: string
    statements: string
  }>`
    SELECT session_user_name, application_name, operation, count(*)::text AS statements
    FROM actor_adoption_writes
    WHERE table_schema = ${target.schema} AND table_name = ${target.table}
      AND observed_at_ms >= ${options.nowMs - options.quietMs}
      AND NOT in_turn AND NOT allowed AND session_user_name NOT IN ${sql.in(["", ...allowed])}
    GROUP BY session_user_name, application_name, operation
    ORDER BY 1, 2, 3`

  for (const writer of recent)
    refusals.push(
      `${writer.session_user_name} (${writer.application_name === "" ? "no application_name" : writer.application_name}) wrote ${name} with ${writer.statements} ${writer.operation} statements inside the quiet window; stop it, or route it through --allow`,
    )

  const both = yield* sql<{ session_user_name: string }>`
    SELECT session_user_name FROM actor_adoption_writes
    WHERE table_schema = ${target.schema} AND table_name = ${target.table}
    GROUP BY session_user_name HAVING bool_or(in_turn) AND bool_or(NOT in_turn)`

  for (const shared of both)
    refusals.push(
      `${shared.session_user_name} wrote ${name} both inside and outside runtime turns; a login that can act as the runtime can take the writer role, so give the application and the runtime separate logins`,
    )

  const [role] = yield* sql<{ exists: boolean }>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${options.writerRole}) AS exists`

  if (role!.exists !== true)
    refusals.push(`role ${options.writerRole} does not exist; create it and grant it the table`)

  const [owner] = yield* sql<{ owner: string; is_writer: boolean }>`
    SELECT r.rolname AS owner, r.rolname = ${options.writerRole} AS is_writer
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = ${target.schema} AND c.relname = ${target.table}`

  if (owner!.is_writer)
    refusals.push(
      `${name} is owned by the writer role ${options.writerRole}; an owner can disable its triggers, so give the table to a role no login is a member of`,
    )

  const actingAsOwner = yield* sql<{ name: string }>`
    SELECT l.rolname AS name FROM pg_roles l
    WHERE l.rolcanlogin AND NOT l.rolsuper AND l.rolname <> session_user
      AND pg_has_role(l.oid, (SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${target.schema} AND c.relname = ${target.table}), 'USAGE')
    ORDER BY 1`

  for (const login of actingAsOwner)
    refusals.push(
      `login ${login.name} can act as ${name}'s owner ${owner!.owner}, so it could disable the guard; give the table to a NOLOGIN role no login is a member of (ALTER TABLE ${table} OWNER TO …)`,
    )

  const runtimeLogins = yield* sql<{ session_user_name: string }>`
    SELECT DISTINCT session_user_name FROM actor_adoption_writes
    WHERE table_schema = ${target.schema} AND table_name = ${target.table} AND in_turn`

  const members = yield* sql<{ name: string }>`
    SELECT l.rolname AS name FROM pg_roles l
    WHERE l.rolcanlogin AND NOT l.rolsuper AND l.rolname <> session_user AND l.rolname <> ${options.writerRole}
      AND EXISTS (SELECT 1 FROM pg_roles w WHERE w.rolname = ${options.writerRole}
        AND pg_has_role(l.oid, w.oid, 'MEMBER'))
    ORDER BY 1`

  for (const member of members)
    if (!runtimeLogins.some((login) => login.session_user_name === member.name))
      refusals.push(
        `login ${member.name} is a member of ${options.writerRole} but no runtime turn was recorded from it, so it could write the table as the runtime; revoke its membership, or let the runtime write the table once while observing`,
      )

  const cascades = yield* sql.unsafe<{ name: string; parent: string; action: string }>(
    `SELECT con.conname AS name, con.confrelid::regclass::text AS parent,
       CASE con.confdeltype WHEN 'c' THEN 'ON DELETE CASCADE' ELSE 'ON DELETE SET NULL' END AS action
     FROM pg_constraint con
     WHERE con.contype = 'f' AND con.conrelid = ${`${literal(quotedTable(target))}::regclass`}
       AND con.confdeltype IN ('c', 'n')
     ORDER BY 1`,
  )

  for (const cascade of cascades)
    refusals.push(
      `foreign key ${cascade.name} of ${name} references ${cascade.parent} with ${cascade.action}; deleting a parent row would change this table as its owner and be rejected by the guard, so resolve it first`,
    )

  return refusals
})

/** What `enforce` did for one table. */
export interface EnforceResult {
  readonly table: string
  readonly writerRole: string
  readonly allowedRoles: ReadonlyArray<string>
  /** Privileges taken away, which `release` gives back. */
  readonly revoked: number
}

/**
 * Enforces each named adopted table of `actors`, in one transaction under a
 * `lock_timeout`. Nothing changes unless every check passes: the table has
 * been observed for the whole quiet window, no legacy write outside `allow`
 * roles fell inside it, no login wrote both in and out of turns, every row
 * has its `routing_key` and owner columns, the owner is a role no login can
 * act as, no other login can take the writer role, and no cascade reaches the
 * table. It then revokes write privileges from every role but the writer and
 * the allowed ones, adds the constraint that keeps `routing_key` and the
 * mapped columns filled, and installs the guard triggers, always enabled.
 */
export const enforceAdoption = Effect.fnUntraced(function* (
  actors: ReadonlyArray<WeakKey>,
  options: {
    readonly only: string
    readonly writerRole: string
    readonly allowedRoles?: ReadonlyArray<string> | undefined
    readonly quietMs?: number | undefined
    readonly lockTimeoutMs?: number | undefined
    readonly nowMs: number
  },
) {
  const sql = yield* SqlClient.SqlClient
  const allowedRoles = options.allowedRoles ?? []

  for (const [role, flag] of [
    [options.writerRole, "--writer-role"],
    ...allowedRoles.map((allowed) => [allowed, "--allow"] as const),
  ] as const) {
    const bad = roleNamed(role, flag)

    if (bad !== undefined) return yield* bad
  }

  if (allowedRoles.includes(options.writerRole))
    return yield* AdoptionRefused.make({
      message: "--allow cannot name the writer role, which already passes",
    })

  const results: Array<EnforceResult> = []

  for (const target of yield* adoptionTargets(actors, options.only)) {
    const name = qualifiedName(target)

    if (target.access === "read")
      return yield* AdoptionRefused.make({
        message: `${name} is adopted for reading only and has no writers to enforce against`,
      })

    results.push(
      yield* Effect.gen(function* () {
        yield* sql`SELECT set_config('lock_timeout', ${`${options.lockTimeoutMs ?? 5000}ms`}, true)`

        const [adoption] = yield* sql<{ actor_type: string; mode: string }>`
          SELECT actor_type, mode FROM actor_adoptions
          WHERE table_schema = ${target.schema} AND table_name = ${target.table} FOR UPDATE`

        if (adoption === undefined)
          return yield* AdoptionRefused.make({
            message: `${name} is not observed; run durable adopt observe ${target.table} first`,
          })

        if (adoption.mode === "enforce")
          return yield* AdoptionRefused.make({ message: `${name} is already enforced` })

        const refusals = yield* enforcementRefusals(target, {
          writerRole: options.writerRole,
          allowedRoles,
          quietMs: options.quietMs ?? DEFAULT_QUIET_MS,
          nowMs: options.nowMs,
        })

        if (refusals.length > 0)
          return yield* AdoptionRefused.make({
            message: `${name} cannot be enforced:\n${refusals.map((refusal) => `  - ${refusal}`).join("\n")}`,
          })

        const table = quotedTable(target)
        const tenant = identifier(target.tenantColumn)
        const actor = identifier(target.actorColumn)

        yield* sql.unsafe(
          `ALTER TABLE ${table} ADD CONSTRAINT actor_adoption_owner CHECK (routing_key IS NOT NULL
             AND ${tenant} IS NOT NULL AND ${actor} IS NOT NULL
             AND ${tenant}::text <> '' AND ${actor}::text <> '') NOT VALID`,
        )
        yield* sql.unsafe(`ALTER TABLE ${table} VALIDATE CONSTRAINT actor_adoption_owner`)

        const revoked = (yield* writeGrants(target)).filter(
          (grant) => grant.grantee !== options.writerRole && !allowedRoles.includes(grant.grantee),
        )

        for (const grant of revoked)
          yield* sql.unsafe(
            `REVOKE ${grant.privilege} ON ${table} FROM ${grant.grantee === "PUBLIC" ? "PUBLIC" : identifier(grant.grantee)}`,
          )

        const args = guardArguments(target, { writerRole: options.writerRole, allowedRoles })
          .map(literal)
          .join(", ")

        const schema = (yield* sql<{
          name: string
        }>`SELECT quote_ident(current_schema()) AS name`)[0]!.name

        yield* sql.unsafe(
          `CREATE TRIGGER actor_adoption_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table}
           FOR EACH ROW EXECUTE FUNCTION ${schema}.actor_adoption_guard(${args})`,
        )
        yield* sql.unsafe(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER actor_adoption_guard`)
        yield* sql.unsafe(
          `CREATE TRIGGER actor_adoption_guard_truncate BEFORE TRUNCATE ON ${table}
           FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.actor_adoption_guard(${args})`,
        )
        yield* sql.unsafe(
          `ALTER TABLE ${table} ENABLE ALWAYS TRIGGER actor_adoption_guard_truncate`,
        )

        yield* installObserveTriggers(target, [options.writerRole, ...allowedRoles])

        const recorded = yield* encodeRevoked(revoked).pipe(Effect.orDie)

        yield* sql`UPDATE actor_adoptions SET mode = 'enforce', writer_role = ${options.writerRole},
            allowed_roles = coalesce(string_to_array(nullif(${allowedRoles.join(",")}, ''), ','), '{}'), revoked = ${recorded}::jsonb,
            changed_at_ms = floor(extract(epoch FROM clock_timestamp()) * 1000), changed_by = session_user
          WHERE table_schema = ${target.schema} AND table_name = ${target.table}`

        return {
          table: name,
          writerRole: options.writerRole,
          allowedRoles,
          revoked: revoked.length,
        } satisfies EnforceResult
      }).pipe(sql.withTransaction),
    )
  }

  return results
})

/**
 * Returns `only` from enforced to observed: drops the guard and the
 * constraint that legacy writers, which supply no `routing_key`, would
 * violate, gives back the privileges `enforce` recorded, and reinstalls the
 * plain observing triggers. It never removes `routing_key` or the record.
 */
export const releaseAdoption = Effect.fnUntraced(function* (
  actors: ReadonlyArray<WeakKey>,
  options: { readonly only: string; readonly lockTimeoutMs?: number | undefined },
) {
  const sql = yield* SqlClient.SqlClient
  const released: Array<string> = []

  for (const target of yield* adoptionTargets(actors, options.only)) {
    const name = qualifiedName(target)

    yield* Effect.gen(function* () {
      yield* sql`SELECT set_config('lock_timeout', ${`${options.lockTimeoutMs ?? 5000}ms`}, true)`

      const [adoption] = yield* sql<{ mode: string; revoked: unknown }>`
        SELECT mode, revoked FROM actor_adoptions
        WHERE table_schema = ${target.schema} AND table_name = ${target.table} FOR UPDATE`

      if (adoption?.mode !== "enforce")
        return yield* AdoptionRefused.make({ message: `${name} is not enforced` })

      const table = quotedTable(target)
      const grants = yield* decodeRevoked(adoption.revoked).pipe(Effect.orDie)

      yield* sql.unsafe(`DROP TRIGGER IF EXISTS actor_adoption_guard ON ${table}`)
      yield* sql.unsafe(`DROP TRIGGER IF EXISTS actor_adoption_guard_truncate ON ${table}`)
      yield* sql.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS actor_adoption_owner`)

      for (const grant of grants)
        yield* sql.unsafe(
          `GRANT ${grant.privilege} ON ${table} TO ${grant.grantee === "PUBLIC" ? "PUBLIC" : identifier(grant.grantee)}`,
        )

      yield* installObserveTriggers(target)

      yield* sql`UPDATE actor_adoptions SET mode = 'observe', writer_role = NULL,
          allowed_roles = '{}', revoked = '[]',
          changed_at_ms = floor(extract(epoch FROM clock_timestamp()) * 1000), changed_by = session_user
        WHERE table_schema = ${target.schema} AND table_name = ${target.table}`
    }).pipe(sql.withTransaction)

    released.push(name)
  }

  return released
})

/** One line per enforced table. */
export const formatEnforce = (result: EnforceResult) =>
  `${result.table} is enforced: writer ${result.writerRole}, ${result.revoked} privileges revoked${result.allowedRoles.length === 0 ? "" : `, allowed roles ${result.allowedRoles.join(", ")}`}`
