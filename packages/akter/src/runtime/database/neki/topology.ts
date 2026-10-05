import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

const Topology = Schema.fromJsonString(
  Schema.Struct({
    default_shard_group: Schema.optional(Schema.String),
    shard_groups: Schema.Array(
      Schema.Struct({
        uid: Schema.String,
        default_shard_index: Schema.optional(Schema.String),
      }),
    ),
    databases: Schema.optional(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          schemas: Schema.optional(
            Schema.Record(
              Schema.String,
              Schema.Struct({
                default_shard_group: Schema.optional(Schema.String),
                tables: Schema.optional(
                  Schema.Record(
                    Schema.String,
                    Schema.Struct({ shard_group: Schema.optional(Schema.String) }),
                  ),
                ),
              }),
            ),
          ),
        }),
      ),
    ),
  }),
)

const decodeTopology = Schema.decodeUnknownEffect(Topology)

/**
 * Which of `tables` the connected Neki database places in a shard group that has a shard index,
 * that is, a group routed by `routing_key`. The router serves only a view over a single table
 * there and refuses one that reads two relations, even of one group. A table's group is its own
 * binding, else the schema's default, else the cluster's. Neither a database without Neki's
 * topology function nor a topology that does not name the database routes anything.
 */
export const routedTables = Effect.fnUntraced(function* (tables: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient

  const [available] = yield* sql<{
    readonly present: boolean
  }>`SELECT to_regprocedure('__neki.get_data_topology()') IS NOT NULL AS present`

  if (available?.present !== true) return []

  const [live] = yield* sql<{
    readonly database: string
    readonly schema: string
    readonly topology: string
  }>`SELECT current_database() AS database, current_schema() AS schema,
      t.data_topology_json AS topology
    FROM __neki.get_data_topology() t`

  if (live === undefined) return []

  const topology = yield* decodeTopology(live.topology).pipe(Effect.orDie)
  const schema = topology.databases?.[live.database]?.schemas?.[live.schema]

  return tables.filter((table) => {
    const group =
      schema?.tables?.[table]?.shard_group ??
      schema?.default_shard_group ??
      topology.default_shard_group

    return topology.shard_groups.some(
      (candidate) => candidate.uid === group && candidate.default_shard_index !== undefined,
    )
  })
})
