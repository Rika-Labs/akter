import { Effect } from "effect"
import { dual } from "effect/Function"
import { SqlClient } from "effect/sql"
import type { SqlConnection, SqlError } from "effect/sql"
import { MigrationBarrier } from "./neki/migrations.ts"
import { NekiTurnSessions } from "./neki/session.ts"

const ddl = /^\s*(?:CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE)\b/i

/**
 * Runs an application's own schema setup on the ambient `SqlClient` while
 * holding advisory lock `lock`, so processes starting together apply it one
 * at a time. On Postgres the lock and every statement share one transaction,
 * as before. Neki neither keeps nor exposes DDL issued inside a transaction,
 * so there every statement autocommits on one reserved session holding the
 * lock, after a barrier for DDL other processes made, and each DDL statement
 * waits for its own propagation before the next statement may depend on it.
 * A crash can therefore leave part of the setup applied on Neki: every
 * statement must be safe to run again.
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
    if (!(yield* NekiTurnSessions))
      return yield* sql.withTransaction(
        Effect.andThen(sql`SELECT pg_advisory_xact_lock(${lock})`, effect),
      )
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* sql.reserve
        const barrier = yield* MigrationBarrier
        yield* Effect.acquireRelease(
          connection.execute(`SELECT pg_advisory_lock(${lock})`, [], undefined),
          () =>
            connection
              .execute(`SELECT pg_advisory_unlock(${lock})`, [], undefined)
              .pipe(Effect.orDie),
        )
        yield* barrier(connection)
        const propagated = <A>(text: string, run: Effect.Effect<A, SqlError.SqlError>) =>
          ddl.test(text) ? Effect.tap(run, () => barrier(connection)) : run
        const session: SqlConnection.Connection = {
          ...connection,
          execute: (text, parameters, transform) =>
            propagated(text, connection.execute(text, parameters, transform)),
          executeUnprepared: (text, parameters, transform) =>
            propagated(text, connection.executeUnprepared(text, parameters, transform)),
        }
        return yield* Effect.provideService(effect, sql.transactionService, [session, 0])
      }),
    )
  }),
)
