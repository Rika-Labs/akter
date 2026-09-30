import { DateTime, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

/** One adopted table as `durable adopt status` reports it. */
export interface AdoptionStatus {
  readonly table: string
  readonly actor: string
  readonly mode: "observe" | "enforce"
  /** Rows still without a `routing_key`; enforcement needs none. */
  readonly unbackfilled: number
  /** The last write neither the runtime nor an allowed role made, in epoch milliseconds. */
  readonly lastLegacyWriteMs: number | undefined
  readonly writerRole: string | undefined
  /** Roles that may still write the table directly; adoption is complete when this is empty. */
  readonly allowedRoles: ReadonlyArray<string>
}

/**
 * Every recorded adoption in the database, with its unbackfilled row count
 * and its last legacy write. Reads only the catalog and the recorded writes,
 * so it needs no actor definitions.
 */
export const adoptionStatus = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const adoptions = yield* sql<{
    table_schema: string
    table_name: string
    actor_type: string
    mode: "observe" | "enforce"
    writer_role: string | null
    allowed_roles: ReadonlyArray<string>
  }>`SELECT table_schema, table_name, actor_type, mode, writer_role, allowed_roles
    FROM actor_adoptions ORDER BY table_schema, table_name`

  const statuses: Array<AdoptionStatus> = []

  for (const adoption of adoptions) {
    const table = `"${adoption.table_schema.replaceAll('"', '""')}"."${adoption.table_name.replaceAll('"', '""')}"`

    const [counted] = yield* sql.unsafe<{ unbackfilled: string }>(
      `SELECT count(*)::text AS unbackfilled FROM ${table} WHERE routing_key IS NULL`,
    )

    const [last] = yield* sql<{ last: string | null }>`
      SELECT max(observed_at_ms)::text AS last FROM actor_adoption_writes
      WHERE table_schema = ${adoption.table_schema} AND table_name = ${adoption.table_name}
        AND NOT in_turn AND NOT allowed`

    statuses.push({
      table: `${adoption.table_schema}.${adoption.table_name}`,
      actor: adoption.actor_type,
      mode: adoption.mode,
      unbackfilled: Number(counted!.unbackfilled),
      lastLegacyWriteMs: last?.last == null ? undefined : Number(last.last),
      writerRole: adoption.writer_role ?? undefined,
      allowedRoles: adoption.allowed_roles,
    })
  }

  return statuses
})

/** One line per adopted table. */
export const formatAdoptionStatus = (status: AdoptionStatus) =>
  [
    `${status.table}  ${status.actor}  ${status.mode}`,
    `${status.unbackfilled} rows without routing_key`,
    status.lastLegacyWriteMs === undefined
      ? "no legacy write recorded"
      : `last legacy write ${DateTime.formatIso(DateTime.makeUnsafe(status.lastLegacyWriteMs))}`,
    ...(status.mode === "enforce"
      ? [
          `writer ${status.writerRole}`,
          status.allowedRoles.length === 0
            ? "no allowed roles: adoption is complete"
            : `allowed roles ${status.allowedRoles.join(", ")}`,
        ]
      : []),
  ].join("  ")
