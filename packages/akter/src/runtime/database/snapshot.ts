import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/**
 * Runs `effect` in a read-only, repeatable-read transaction, so every read in
 * it sees one snapshot and Postgres refuses any write it could attempt.
 */
export const inReadOnlySnapshot = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.pipe(Effect.andThen(effect)),
    ),
  )
