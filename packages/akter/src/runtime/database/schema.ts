import { Effect } from "effect"
import { dual } from "effect/Function"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql"

/**
 * Runs an application's own schema setup on the ambient `SqlClient` while
 * holding advisory lock `lock`, so processes starting together apply it one
 * at a time. The lock and every statement share one transaction, so a failed
 * setup rolls back together and releases its lock.
 */
export const schemaChange: {
  (
    lock: number,
  ): <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError.SqlError, R | SqlClient.SqlClient>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    lock: number,
  ): Effect.Effect<A, E | SqlError.SqlError, R | SqlClient.SqlClient>
} = dual(2, <A, E, R>(effect: Effect.Effect<A, E, R>, lock: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.andThen(sql`SELECT pg_advisory_xact_lock(${lock})`, effect),
    )
  }),
)
