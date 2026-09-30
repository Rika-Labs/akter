import { Clock, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { AnyFleetView } from "../../tables/fleet.ts"
import { FLEET_PUBLICATION, FLEET_SLOT, type ResolvedView } from "./maintainer.ts"

const refuse = (message: string) => Effect.die(new Error(`Fleet views cannot start: ${message}`))

const currentSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  return (yield* sql<{ schema: string }>`SELECT current_schema() AS schema`)[0]!.schema
})

/** Resolves each view's source and derived table schemas on this database. */
export const resolveViews = Effect.fnUntraced(function* (views: ReadonlyArray<AnyFleetView>) {
  const schema = yield* currentSchema

  return views.map((view): ResolvedView => ({
    view,
    sourceSchema: view.source.schema ?? schema,
    derivedSchema: view.source.schema ?? schema,
  }))
})

/**
 * Refuses to start fleet views on a database that cannot maintain them, each
 * time naming the fix: `wal_level` below logical, a login without
 * `REPLICATION`, a source outside the publication or without full replica
 * identity, a missing or lost slot, a source whose actor type is not placed
 * by tenant, a source without an index leading with
 * `(routing_key, tenant_id, …group columns)`, a missing derived table, and a
 * derived table the tenant role owns, which would let a turn bypass its
 * policy. Then records each view, marking one whose definition changed stale.
 */
export const checkFleet = Effect.fnUntraced(function* (
  views: ReadonlyArray<AnyFleetView>,
  tenantRole: string | undefined,
) {
  const sql = yield* SqlClient.SqlClient

  const names = views.map(({ name }) => name)

  if (new Set(names).size !== names.length)
    return yield* refuse(`a view name is registered twice (${names.join(", ")})`)

  const [level] = yield* sql<{
    wal_level: string
  }>`SELECT current_setting('wal_level') AS wal_level`

  if (level?.wal_level !== "logical")
    return yield* refuse(
      `wal_level is ${level?.wal_level}; set wal_level = logical (ALTER SYSTEM SET wal_level = logical) and restart Postgres`,
    )

  const [login] = yield* sql<{ name: string; replication: boolean }>`
    SELECT rolname AS name, rolreplication OR rolsuper AS replication FROM pg_roles
    WHERE rolname = session_user`

  if (login?.replication !== true)
    return yield* refuse(
      `login ${login?.name} lacks REPLICATION, which the slot functions need; run ALTER ROLE ${login?.name} REPLICATION`,
    )

  const resolved = yield* resolveViews(views)

  for (const { view, sourceSchema, derivedSchema } of resolved) {
    const source = `${sourceSchema}.${view.source.table}`

    if (view.source.owner === undefined)
      return yield* refuse(`${view.name} reads ${source}, which no Actor.make lists in tables`)

    if (view.source.placement !== "tenant")
      return yield* refuse(
        `${view.name} reads ${source} of actor ${view.source.owner}, which is not placed by tenant; a fleet view needs placement: "tenant"`,
      )

    const [table] = yield* sql<{ identity: string; published: boolean }>`
      SELECT c.relreplident AS identity,
        EXISTS (SELECT 1 FROM pg_publication_tables p WHERE p.pubname = ${FLEET_PUBLICATION}
          AND p.schemaname = n.nspname AND p.tablename = c.relname) AS published
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${sourceSchema} AND c.relname = ${view.source.table}`

    if (table === undefined)
      return yield* refuse(
        `${view.name} reads ${source}, which does not exist; apply its drizzle-kit migration`,
      )

    if (!table.published)
      return yield* refuse(
        `${source} is not in publication ${FLEET_PUBLICATION}; run durable fleet setup`,
      )

    if (table.identity !== "f")
      return yield* refuse(
        `${source} does not have full replica identity; run durable fleet setup (ALTER TABLE ${source} REPLICA IDENTITY FULL)`,
      )

    const leading = ["routing_key", "tenant_id", ...view.groupColumns]

    const indexes = yield* sql<{ columns: ReadonlyArray<string> }>`
      SELECT array(
          SELECT a.attname FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, position)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          ORDER BY k.position) AS columns
      FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${sourceSchema} AND c.relname = ${view.source.table}
        AND i.indisvalid AND i.indpred IS NULL`

    if (!indexes.some(({ columns }) => leading.every((column, index) => columns[index] === column)))
      return yield* refuse(
        `${view.name} recomputes a group with one indexed read of ${source}; create its index: CREATE INDEX ${view.source.table}_${view.tableName.split(".").at(-1)} ON ${source} (${leading.join(", ")})`,
      )

    const derived = view.tableName.split(".").at(-1)!

    const [owner] = yield* sql<{ owned_by_tenant: boolean }>`
      SELECT ${tenantRole === undefined ? sql`false` : sql`pg_has_role(${tenantRole}, c.relowner, 'MEMBER')`}
        AS owned_by_tenant
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${derivedSchema} AND c.relname = ${derived}`

    if (owner === undefined)
      return yield* refuse(
        `the derived table ${derivedSchema}.${derived} of ${view.name} does not exist; add ${view.name}.table to the drizzle-kit schema and apply its migration`,
      )

    if (owner.owned_by_tenant)
      return yield* refuse(
        `the tenant role ${tenantRole} owns ${derivedSchema}.${derived}, so its policy would not bind it; give the table to another role`,
      )
  }

  const [slot] = yield* sql<{ wal_status: string | null }>`
    SELECT wal_status FROM pg_replication_slots
    WHERE slot_name = ${FLEET_SLOT} AND database = current_database() AND slot_type = 'logical'`

  if (slot === undefined)
    return yield* refuse(`replication slot ${FLEET_SLOT} does not exist; run durable fleet setup`)

  if (slot.wal_status === "lost")
    return yield* refuse(
      `replication slot ${FLEET_SLOT} is lost; run durable fleet setup to recreate it, and every view rebuilds`,
    )

  const at = yield* Clock.currentTimeMillis

  for (const { view, sourceSchema } of resolved) {
    yield* sql`INSERT INTO actor_fleet_views (view_name, source_schema, source_table, definition_hash,
        status, applied_lsn, updated_at_ms, last_error)
      VALUES (${view.name}, ${sourceSchema}, ${view.source.table}, ${view.definitionHash},
        'building', NULL, ${at}, NULL)
      ON CONFLICT (view_name) DO UPDATE SET source_schema = EXCLUDED.source_schema,
        source_table = EXCLUDED.source_table, definition_hash = EXCLUDED.definition_hash,
        status = 'stale', last_error = NULL, updated_at_ms = EXCLUDED.updated_at_ms
      WHERE actor_fleet_views.definition_hash <> EXCLUDED.definition_hash`
  }

  return resolved
})
