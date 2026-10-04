import type { PgConnection } from "@effect/sql-pg"
import { Effect, Stream } from "effect"
import type { SqlConnection, SqlError } from "effect/sql"

/** A leased session as a `SqlClient` connection, so the runtime's statements reach it. */
export const asSqlConnection = ({
  connection,
  send,
}: {
  readonly connection: PgConnection.PgConnection
  readonly send: <A>(
    statement: Effect.Effect<A, SqlError.SqlError>,
  ) => Effect.Effect<A, SqlError.SqlError>
}): SqlConnection.Connection => {
  const rows =
    (prepare: boolean): SqlConnection.Connection["execute"] =>
    (sql, params, transformRows) => {
      const found = send(
        Effect.map(connection.query(sql, params, prepare), (result) => result.rows),
      )

      return transformRows === undefined ? found : Effect.map(found, transformRows)
    }

  return {
    execute: rows(true),
    executeRaw: (sql, params) => send(connection.query(sql, params)),
    executeStream: (sql, params, transformRows) =>
      Stream.unwrap(
        Effect.as(
          send(Effect.void),
          transformRows === undefined
            ? connection.stream(sql, params)
            : Stream.map(connection.stream(sql, params), (row) => transformRows([row])[0]!),
        ),
      ),
    executeValues: (sql, params) => send(connection.queryValues(sql, params)),
    executeValuesUnprepared: (sql, params) => send(connection.queryValues(sql, params, false)),
    executeUnprepared: rows(false),
  }
}
