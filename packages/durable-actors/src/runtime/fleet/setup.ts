import { Clock, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { AnyFleetView } from "../../tables/fleet.ts"
import { resolveViews } from "./checks.ts"
import { FLEET_PUBLICATION, FLEET_SLOT } from "./maintainer.ts"

/** The server cannot hold fleet views; the message names the fix. */
export class FleetSetupRefused extends Schema.TaggedError<FleetSetupRefused>()(
  "FleetSetupRefused",
  { message: Schema.String },
) {}

/** What `setupFleet` changed, for the operator's report. */
export interface FleetSetup {
  readonly sources: ReadonlyArray<string>
  readonly slot: "created" | "recreated" | "kept"
}

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`

/**
 * The operator step before fleet views run, as a role that may alter the
 * source tables and create publications and slots: gives each source full
 * replica identity, so an update tells the maintainer the group a row left;
 * sets publication `durable_fleet` to exactly the sources; and creates the
 * logical slot, recreating it when it was lost. Refuses a server whose
 * `wal_level` is below logical.
 */
export const setupFleet = Effect.fnUntraced(function* (views: ReadonlyArray<AnyFleetView>) {
  const sql = yield* SqlClient.SqlClient

  const [level] = yield* sql<{
    wal_level: string
  }>`SELECT current_setting('wal_level') AS wal_level`

  if (level?.wal_level !== "logical")
    return yield* FleetSetupRefused.make({
      message: `wal_level is ${level?.wal_level}; set wal_level = logical (ALTER SYSTEM SET wal_level = logical) and restart Postgres`,
    })

  const resolved = yield* resolveViews(views)

  const sources = [
    ...new Set(
      resolved.map(
        ({ view, sourceSchema }) => `${identifier(sourceSchema)}.${identifier(view.source.table)}`,
      ),
    ),
  ]

  for (const source of sources) yield* sql.unsafe(`ALTER TABLE ${source} REPLICA IDENTITY FULL`)

  const [publication] = yield* sql<{ found: boolean }>`
    SELECT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = ${FLEET_PUBLICATION}) AS found`

  yield* sql.unsafe(
    publication?.found === true
      ? `ALTER PUBLICATION ${FLEET_PUBLICATION} SET TABLE ${sources.join(", ")}`
      : `CREATE PUBLICATION ${FLEET_PUBLICATION} FOR TABLE ${sources.join(", ")}
          WITH (publish = 'insert, update, delete, truncate')`,
  )

  const [slot] = yield* sql<{ wal_status: string | null }>`
    SELECT wal_status FROM pg_replication_slots
    WHERE slot_name = ${FLEET_SLOT} AND database = current_database()`

  if (slot !== undefined && slot.wal_status !== "lost")
    return { sources, slot: "kept" } satisfies FleetSetup

  if (slot !== undefined)
    yield* sql`SELECT 1 FROM (SELECT pg_drop_replication_slot(${FLEET_SLOT})) dropped`

  yield* sql`SELECT 1 FROM pg_create_logical_replication_slot(${FLEET_SLOT}, 'pgoutput')`

  return { sources, slot: slot === undefined ? "created" : "recreated" } satisfies FleetSetup
})

/**
 * Asks the maintainer to rebuild `view` from its source: the view goes back
 * to `building` and its error is cleared, so a poisoned view runs again.
 * Returns false when no runtime has registered the view.
 */
export const rebuildFleetView = Effect.fnUntraced(function* (view: string) {
  const sql = yield* SqlClient.SqlClient
  const at = yield* Clock.currentTimeMillis

  const rows = yield* sql<{ view_name: string }>`UPDATE actor_fleet_views
    SET status = 'building', last_error = NULL, updated_at_ms = ${at}
    WHERE view_name = ${view} RETURNING view_name`

  return rows.length > 0
})
