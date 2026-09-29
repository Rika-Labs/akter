import { PgClient } from "@effect/sql-pg"
import { PgliteClient } from "@effect/sql-pglite"
import { Context, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ContentStore } from "../../handles/content.ts"

/**
 * Makes an effect layer unassignable when its executors or its build need a
 * SQL client or the content store, since a capability captured at build time
 * would reach executors.
 */
export type NoDatabase<R> = [
  Extract<
    R,
    SqlClient.SqlClient | PgClient.PgClient | PgliteClient.PgliteClient | ContentStore
  >,
] extends [never]
  ? unknown
  : { readonly "Executors have no database capability": never }

/**
 * Runs an executor attempt in its layer's build context without the SQL
 * client or the content store, even when that layer was built where they are provided.
 */
export const withoutDatabase =
  (services: Context.Context<never>) =>
  <A, E>(attempt: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    attempt.pipe(
      Effect.updateContext(() =>
        Context.omit(
          SqlClient.SqlClient,
          PgClient.PgClient,
          PgliteClient.PgliteClient,
          ContentStore,
        )(services),
      ),
    )
