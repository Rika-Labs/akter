import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { ActorRef } from "../../identity/caller.ts"
import { routingKey } from "../storage/codec.ts"
import { quotedTable } from "./plan.ts"
import { AdoptionRefused, adoptionTargets, qualifiedName, type AdoptionTarget } from "./target.ts"

/** What a backfill did for one table. */
export interface BackfillResult {
  readonly table: string
  /** Rows given a `routing_key`. */
  readonly filled: number
  /** Full passes over the table; the last one found nothing left to fill. */
  readonly passes: number
}

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

const UNOWNED_SAMPLE = 20

/**
 * Fills `routing_key` of every row of each observed table of `actors`, in
 * primary-key batches that are each their own transaction, with the runtime's
 * own `routingKey` and the type's placement so a row's key equals the key of
 * an actor that writes it. Nothing is stored between batches: a killed run
 * starts again and finds only the rows still without a key. Rows written by
 * legacy code meanwhile carry none, so it repeats until a pass fills nothing.
 * A table with a NULL or empty mapped column is refused and its rows listed,
 * because no actor owns them.
 */
export const backfillAdoption = Effect.fnUntraced(function* (
  actors: ReadonlyArray<WeakKey>,
  options: { readonly only?: string | undefined; readonly batch?: number | undefined },
) {
  const batch = options.batch ?? 1000

  if (!Number.isInteger(batch) || batch < 1)
    return yield* AdoptionRefused.make({ message: "--batch is a positive integer" })

  const results: Array<BackfillResult> = []

  for (const target of yield* adoptionTargets(actors, options.only)) {
    if (target.access === "read") {
      if (options.only !== undefined)
        return yield* AdoptionRefused.make({
          message: `${qualifiedName(target)} is adopted for reading only and has no routing_key`,
        })

      continue
    }

    results.push(yield* backfillTable(target, batch))
  }

  return results
})

const backfillTable = Effect.fnUntraced(function* (target: AdoptionTarget, batch: number) {
  const sql = yield* SqlClient.SqlClient
  const name = qualifiedName(target)

  const [adoption] = yield* sql<{ mode: string; actor_type: string }>`
    SELECT mode, actor_type FROM actor_adoptions
    WHERE table_schema = ${target.schema} AND table_name = ${target.table}`

  if (adoption === undefined)
    return yield* AdoptionRefused.make({
      message: `${name} is not observed; run durable adopt observe ${target.table} first`,
    })

  if (adoption.mode === "enforce")
    return yield* AdoptionRefused.make({
      message: `${name} is enforced, so every row already has a routing_key`,
    })

  const table = quotedTable(target)
  const tenant = identifier(target.tenantColumn)
  const actor = identifier(target.actorColumn)
  const keys = target.primaryKey.map(identifier)
  const owned = `${tenant} IS NOT NULL AND ${actor} IS NOT NULL AND ${tenant}::text <> '' AND ${actor}::text <> ''`

  const unowned = yield* sql.unsafe<Record<string, string>>(
    `SELECT ${keys.map((key, index) => `${key}::text AS k${index}`).join(", ")}
     FROM ${table} WHERE NOT (${owned}) ORDER BY ${keys.join(", ")} LIMIT ${UNOWNED_SAMPLE}`,
  )

  if (unowned.length > 0)
    return yield* AdoptionRefused.make({
      message: `${name} has rows whose ${target.tenantColumn} or ${target.actorColumn} is NULL or empty, so no actor owns them; fix them first. First rows by primary key (${target.primaryKey.join(", ")}): ${unowned
        .map((row) => `(${Object.values(row).join(", ")})`)
        .join(" ")}`,
    })

  const types = yield* sql<{ name: string; type: string }>`
    SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${target.schema} AND c.relname = ${target.table}
      AND a.attname IN ${sql.in([...target.primaryKey, target.tenantColumn, target.actorColumn])}`

  const typeOf = (column: string) => types.find((type) => type.name === column)!.type
  const keyTypes = target.primaryKey.map(typeOf)
  const tenantType = typeOf(target.tenantColumn)
  const actorType = typeOf(target.actorColumn)

  let filled = 0
  let passes = 0

  for (;;) {
    passes += 1
    let cursor: ReadonlyArray<string> | undefined
    let passFilled = 0

    for (;;) {
      const after =
        cursor === undefined
          ? ""
          : `AND (${keys.join(", ")}) > (${cursor.map((value, index) => `${literal(value)}::${keyTypes[index]}`).join(", ")})`

      const rows = yield* sql.unsafe<Record<string, string>>(
        `SELECT ${tenant}::text AS tenant, ${actor}::text AS actor,
           ${keys.map((key, index) => `${key}::text AS k${index}`).join(", ")}
         FROM ${table} WHERE routing_key IS NULL AND ${owned} ${after}
         ORDER BY ${keys.join(", ")} LIMIT ${batch}`,
      )

      if (rows.length === 0) break

      const values = yield* Effect.forEach(rows, (row) =>
        Effect.try({
          try: () =>
            routingKey({
              ref: ActorRef.make({
                tenant: row["tenant"]!,
                actor: target.actor,
                id: row["actor"]!,
              }),
              placement: target.placement,
            }),
          catch: (cause) =>
            AdoptionRefused.make({
              message: `${name} row ${target.primaryKey.map((_, index) => row[`k${index}`]).join(", ")}: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        }),
      )

      const parameters = rows.flatMap((row, index) => [
        row["tenant"]!,
        row["actor"]!,
        ...target.primaryKey.map((_, key) => row[`k${key}`]!),
        values[index]!.toString(),
      ])

      const width = 3 + target.primaryKey.length

      const tuples = rows
        .map((_, index) => {
          const base = index * width

          const cast = [
            `$${base + 1}::${tenantType}`,
            `$${base + 2}::${actorType}`,
            ...keyTypes.map((type, key) => `$${base + 3 + key}::${type}`),
            `$${base + width}::bigint`,
          ]

          return `(${cast.join(", ")})`
        })
        .join(", ")

      const match = [
        `t.${tenant} = v.tenant`,
        `t.${actor} = v.actor`,
        ...keys.map((key, index) => `t.${key} = v.k${index}`),
      ].join(" AND ")

      const updated = yield* Effect.gen(function* () {
        yield* sql`SELECT set_config('durable.backfill', 'on', true)`

        return yield* sql.unsafe<{ n: string }>(
          `WITH changed AS (
             UPDATE ${table} AS t SET routing_key = v.routing_key
             FROM (VALUES ${tuples}) AS v (tenant, actor, ${keys.map((_, index) => `k${index}`).join(", ")}, routing_key)
             WHERE ${match} AND t.routing_key IS NULL RETURNING 1)
           SELECT count(*)::text AS n FROM changed`,
          parameters,
        )
      }).pipe(sql.withTransaction)

      passFilled += Number(updated[0]!.n)
      cursor = target.primaryKey.map((_, index) => rows[rows.length - 1]![`k${index}`]!)
    }

    filled += passFilled

    if (passFilled === 0) return { table: name, filled, passes } satisfies BackfillResult
  }
})

/** One line per table: how many rows were filled and how many passes it took. */
export const formatBackfill = (result: BackfillResult) =>
  `${result.table}: filled routing_key on ${result.filled} rows in ${result.passes} pass${result.passes === 1 ? "" : "es"}`
