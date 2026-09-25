import { Context, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

/** Makes an effect layer whose executors need a SQL client unassignable. */
export type NoDatabase<R> = [Extract<R, SqlClient.SqlClient>] extends [never]
  ? unknown
  : { readonly "Executors have no database capability": never }

/**
 * Runs an executor attempt in its layer's build context without the SQL
 * client, even when that layer was built where one is provided.
 */
export const withoutDatabase =
  (services: Context.Context<never>) =>
  <A, E>(attempt: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    attempt.pipe(Effect.updateContext(() => Context.omit(SqlClient.SqlClient)(services)))
