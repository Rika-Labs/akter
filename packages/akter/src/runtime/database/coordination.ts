import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer } from "effect"
import { Reactivity } from "effect/reactivity"
import { Migrator, SqlClient } from "effect/sql"

/** The deployment's unsharded authority, shared by every runner regardless of its data shard. */
export const Coordination = Context.Reference<SqlClient.SqlClient | undefined>(
  "@rikalabs/akter/runtime/database/coordination/Coordination",
  { defaultValue: () => undefined },
)

/** Creates the transaction-owned coordination rows on the authoritative database. */
const prepareCoordination = (sql: SqlClient.SqlClient) =>
  sql`CREATE TABLE IF NOT EXISTS actor_coordination (
    resource text PRIMARY KEY
  )`.pipe(Effect.asVoid)

/** Supplies an independent client so coordination transactions never borrow a data transaction's connection. */
export const coordinationLayer = (options: PgClient.PgPoolConfig | undefined) =>
  Layer.effect(
    Coordination,
    Effect.gen(function* () {
      if (options === undefined) return undefined
      const sql = yield* PgClient.make(options)
      yield* Migrator.make({})({
        table: "actor_coordination_migrations",
        loader: Migrator.fromRecord({ "0001_coordination": prepareCoordination(sql) }),
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)
      return sql
    }),
  ).pipe(Layer.provide(Reactivity.layer))

/**
 * Serializes one resource on the authoritative database until the guarded work
 * has committed or rolled back. The row lock is the ownership fence: there is
 * no clock-based expiry that could admit a second owner while the first writes.
 * Row identities are retained so deleting an idle resource cannot split its lock.
 * The local fence has its own namespace because independent clients may point
 * to the same database and must not wait on their own authority transaction.
 */
export const coordinated = <A, E, R>({
  resource,
  work,
}: {
  readonly resource: string
  readonly work: Effect.Effect<A, E, R>
}) =>
  Effect.gen(function* () {
    const data = yield* SqlClient.SqlClient
    const sql = (yield* Coordination) ?? data
    const guarded =
      sql === data
        ? work
        : data.withTransaction(
            data`INSERT INTO actor_coordination (resource) VALUES (${`local/${resource}`})
        ON CONFLICT (resource) DO UPDATE SET resource = EXCLUDED.resource`.pipe(
              Effect.andThen(work),
              Effect.tap(() => sql`SELECT 1`),
            ),
          )
    const alive = sql`SELECT 1`.pipe(Effect.andThen(Effect.sleep("200 millis")), Effect.forever)
    return yield* sql.withTransaction(
      sql`INSERT INTO actor_coordination (resource) VALUES (${resource})
        ON CONFLICT (resource) DO UPDATE SET resource = EXCLUDED.resource`.pipe(
        Effect.andThen(sql === data ? guarded : Effect.raceFirst(guarded, alive)),
      ),
    )
  })
