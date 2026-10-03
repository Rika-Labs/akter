import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { BUCKETS } from "../turn/outbox.ts"

/** One inclusive bucket range on one database shard, independent of actor compute ownership. */
export interface BucketRange {
  readonly first: number
  readonly last: number
  /** Neki's shard UID; absent on an ordinary single database. */
  readonly shard?: string | undefined
}

/** The data ranges this runner may scan; ordinary databases have one range and no session setting. */
export const ShardMap = Context.Reference<ReadonlyArray<BucketRange>>("akter/ShardMap", {
  defaultValue: () => [BUCKETS],
})

/**
 * Gives each targeted range its own session for the lifetime of the caller's
 * scope. A shard setting cannot leak into the shared off-turn pool, and a
 * failed setup closes the session instead of returning it to another user.
 * Untargeted ranges reuse the existing client without a setting or a lease.
 */
export const shardClients = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const ranges = yield* ShardMap
  const sorted = [...ranges].sort((a, b) => a.first - b.first)

  for (const [index, range] of sorted.entries()) {
    if (
      !Number.isInteger(range.first) ||
      !Number.isInteger(range.last) ||
      range.first < BUCKETS.first ||
      range.last > BUCKETS.last ||
      range.first > range.last ||
      (index > 0 && sorted[index - 1]!.last >= range.first) ||
      range.shard === ""
    )
      return yield* Effect.die(new Error("Invalid or overlapping shard bucket ranges"))
  }

  return yield* Effect.forEach(ranges, (range) =>
    Effect.gen(function* () {
      if (range.shard === undefined) return { range, sql }

      const postgres = yield* PgClient.PgClient
      const client = Context.get(
        yield* Layer.build(PgClient.layerFrom(PgClient.makeClient(postgres.config))),
        SqlClient.SqlClient,
      )
      yield* client`SET __neki.shard = ${client.literal(`'${range.shard.replaceAll("'", "''")}'`)}`

      return { range, sql: client }
    }),
  )
})
