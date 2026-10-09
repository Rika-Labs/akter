import { Effect } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import {
  AUTHORITY_BUCKET,
  authorityKey,
  parentPlacement,
  type Placement,
  PLACEMENT_ENCODING,
  placementKind,
} from "./codec.ts"

/**
 * The per-actor tables that keep an actor's rows under its routing key, each
 * with the column that names the actor's type and whether it carries the
 * key's `bucket`. `actor_generations` and `actor_workflow_executions` are
 * referenced by the others' foreign keys, so their rows are copied to the new
 * key and deleted afterwards instead of updated.
 */
const KEYED: ReadonlyArray<{
  readonly table: string
  readonly type: "actor_type" | "source_type"
  readonly bucket?: true
}> = [
  { table: "actor_state", type: "actor_type" },
  { table: "actor_receipts", type: "actor_type" },
  { table: "actor_events", type: "actor_type" },
  { table: "actor_outbox", type: "actor_type", bucket: true },
  { table: "actor_dead_letters", type: "actor_type" },
  { table: "actor_blobs", type: "actor_type" },
  { table: "actor_connections", type: "actor_type", bucket: true },
  { table: "actor_content_refs", type: "actor_type" },
  { table: "actor_subscription_cursors", type: "actor_type" },
  { table: "actor_subscriptions", type: "source_type", bucket: true },
  { table: "actor_subscription_tags", type: "source_type" },
  { table: "actor_operator_audit", type: "actor_type" },
  { table: "actor_cold_garbage", type: "actor_type" },
]

/** The per-actor tables `moveToAuthority` rewrites, for the catalog check that none is missed. */
export const AUTHORITY_MOVED_TABLES: ReadonlyArray<string> = [
  "actor_generations",
  "actor_workflow_executions",
  "actor_workflow_step",
  ...KEYED.map(({ table }) => table),
]

const LOW_56 = (1n << 56n) - 1n

/**
 * Moves every row of `name`'s actors from its tenant-placed keys to its
 * authority-placed keys, in the caller's transaction: the framework's
 * per-actor rows and the rows of every table `actor_tables` records it as
 * owning. Rows already in `AUTHORITY_BUCKET` keep their key, which is the
 * same under both placements. It returns how many actors moved.
 *
 * A runner that still computes the old keys would recreate an actor under
 * them, so this runs only at the start of a release that replaced every
 * runner of the previous one.
 */
const moveToAuthority = Effect.fnUntraced(function* (name: string) {
  const sql = yield* SqlClient.SqlClient

  const high = authorityKey(0n)
  const moved = sql`(routing_key & ${LOW_56}) | ${high}`
  const stale = sql`(routing_key >> 56) <> ${AUTHORITY_BUCKET}`

  const copy = (table: "actor_generations" | "actor_workflow_executions") =>
    Effect.gen(function* () {
      const columns = yield* sql<{ readonly name: string }>`SELECT attname AS name FROM pg_attribute
        WHERE attrelid = ${table}::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`

      return yield* sql`INSERT INTO ${sql(table)} (${sql.csv(columns.map(({ name }) => sql`${sql(name)}`))})
        SELECT ${sql.csv(columns.map(({ name }) => (name === "routing_key" ? moved : sql`${sql(name)}`)))}
        FROM ${sql(table)} WHERE actor_type = ${name} AND ${stale}
        RETURNING actor_id`
    })

  const generations = yield* copy("actor_generations")

  yield* copy("actor_workflow_executions")
  yield* sql`UPDATE actor_workflow_step SET routing_key = ${moved}
    WHERE actor_type = ${name} AND ${stale}`
  yield* sql`DELETE FROM actor_workflow_executions WHERE actor_type = ${name} AND ${stale}`

  for (const keyed of KEYED)
    yield* sql`UPDATE ${sql(keyed.table)} SET routing_key = ${moved}
      ${keyed.bucket === true ? sql`, bucket = ${AUTHORITY_BUCKET}` : sql.literal("")}
      WHERE ${sql(keyed.type)} = ${name} AND ${stale}`

  yield* sql`DELETE FROM actor_generations WHERE actor_type = ${name} AND ${stale}`

  const owned = yield* sql<{ readonly schema: string; readonly table: string }>`
    SELECT t.table_schema AS schema, t.table_name AS table FROM actor_tables t
    WHERE t.actor_type = ${name} AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass(format('%I.%I', t.table_schema, t.table_name))
        AND a.attname = 'routing_key' AND NOT a.attisdropped)
    ORDER BY t.table_schema, t.table_name`

  for (const { schema, table } of owned)
    yield* sql`UPDATE ${sql(schema)}.${sql(table)} SET routing_key = ${moved}
      WHERE routing_key IS NOT NULL AND ${stale}`

  return generations.length
})

/**
 * Records `name`'s placement on first registration and refuses one that
 * differs from the record, for the type and every ancestor it routes through:
 * a changed placement, encoding, or parent would read and write under
 * different routing keys. The one change it makes instead of refusing is a
 * tenant-placed type that now declares authority placement: its rows move to
 * the new keys and the record changes in one transaction, under the record's
 * row lock, so concurrent starts move them once.
 */
export const checkPlacement = ({
  name,
  placement,
}: {
  readonly name: string
  readonly placement: Placement
}): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const kind = placementKind(placement)
    const above = parentPlacement(placement)
    const parent = above?.parent ?? null

    yield* sql`INSERT INTO actor_placements (actor_type, placement, encoding, parent_type)
    VALUES (${name}, ${kind}, ${PLACEMENT_ENCODING}, ${parent})
    ON CONFLICT DO NOTHING`

    const read = (lock: boolean) =>
      Effect.map(
        sql<{
          placement: string
          encoding: number
          parent_type: string | null
        }>`SELECT placement, encoding, parent_type FROM actor_placements WHERE actor_type = ${name}
        ${lock ? sql.literal("FOR UPDATE") : sql.literal("")}`,
        ([row]) => row,
      )

    const matches = (recorded: Effect.Success<ReturnType<typeof read>>) =>
      recorded?.placement === kind &&
      recorded.encoding === PLACEMENT_ENCODING &&
      recorded.parent_type === parent

    const recorded = yield* read(false)

    if (
      !matches(recorded) &&
      kind === "authority" &&
      recorded?.placement === "tenant" &&
      recorded.encoding === PLACEMENT_ENCODING
    )
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (matches(yield* read(true))) return

          const moved = yield* moveToAuthority(name)

          yield* sql`UPDATE actor_placements SET placement = ${kind} WHERE actor_type = ${name}`
          yield* Effect.logInfo(`Moved ${moved} actors of ${name} to authority placement`)
        }),
      )

    if (!matches(yield* read(false)))
      return yield* Effect.die(
        new Error(`Actor ${name} placement differs from the deployment; migrate explicitly`),
      )

    if (above !== undefined)
      yield* checkPlacement({ name: above.parent, placement: above.placement })
  })

/** The placement recorded for `actorType`, resolved through its parents, or `undefined` if none is. */
export const recordedPlacement = (
  actorType: string,
): Effect.Effect<Placement | undefined, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const [recorded] = yield* sql<{
      placement: "tenant" | "actor" | "authority" | "parent"
      parent_type: string | null
    }>`SELECT placement, parent_type FROM actor_placements WHERE actor_type = ${actorType}`

    if (recorded === undefined) return undefined

    if (recorded.placement !== "parent") return recorded.placement

    const parent = yield* recordedPlacement(recorded.parent_type!)

    if (parent === undefined)
      return yield* Effect.die(
        new Error(`Actor ${actorType}'s parent ${recorded.parent_type} has no recorded placement`),
      )

    return { parent: recorded.parent_type!, placement: parent }
  })
