import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer, type Scope } from "effect"
import { Reactivity } from "effect/reactivity"
import { Migrator, SqlClient } from "effect/sql"
import { boundedPool } from "./bounded.ts"

/** The deployment's coordination database, shared by every runner. */
export const Coordination = Context.Reference<SqlClient.SqlClient | undefined>(
  "@rikalabs/akter/runtime/database/coordination/Coordination",
  { defaultValue: () => undefined },
)

/** Deployment registries belong to the data database. */
export const registry = SqlClient.SqlClient

/** The client deployment-wide locks are taken on: the designated coordination pool, else `registry`. */
export const authority = Coordination.pipe(
  Effect.filterOrElse(
    (designated): designated is SqlClient.SqlClient => designated !== undefined,
    () => registry,
  ),
)

/** Creates the transaction-owned coordination rows on the authoritative database. */
const prepareCoordination = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS actor_coordination (
    resource text PRIMARY KEY
  )`
})

/** Holds startup coordination before even the history table is created, on one leased session. */
export const withMigrationCoordination = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = yield* SqlClient.SqlClient
      const connection = yield* source.reserve
      yield* Effect.acquireRelease(
        connection.execute("SELECT pg_advisory_lock(1935764837, 487)", [], undefined),
        () =>
          connection
            .execute("SELECT pg_advisory_unlock(1935764837, 487)", [], undefined)
            .pipe(Effect.orDie),
      )
      const reactivity = yield* Reactivity.make
      const client = yield* SqlClient.make({
        acquirer: Effect.succeed(connection),
        compiler: PgClient.makeCompiler(),
        spanAttributes: [],
      }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity))
      return yield* Effect.provideService(effect, SqlClient.SqlClient, client)
    }),
  )

/** Supplies an independent client so coordination transactions never borrow a data transaction's connection. */
export const coordinationLayer = (options: PgClient.PgPoolConfig | undefined) =>
  Layer.effect(
    Coordination,
    Effect.gen(function* () {
      if (options === undefined) return undefined
      const sql = yield* boundedPool(options)
      yield* withMigrationCoordination(
        Migrator.make({})({
          table: "actor_coordination_migrations",
          loader: Migrator.fromRecord({ "0001_coordination": prepareCoordination }),
        }),
      ).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie)
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
 * Work that writes no actor data, such as accepting a deployment, passes
 * `writesData: false` and holds no data transaction.
 */
export const coordinated = <A, E, R>({
  resource,
  work,
  writesData = true,
}: {
  readonly resource: string
  readonly work: Effect.Effect<A, E, R>
  readonly writesData?: boolean
}) =>
  Effect.gen(function* () {
    const data = yield* SqlClient.SqlClient
    const sql = yield* authority
    const guarded =
      sql === data || !writesData
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
