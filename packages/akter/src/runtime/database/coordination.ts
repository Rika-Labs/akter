import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer } from "effect"
import { Reactivity } from "effect/reactivity"
import { Migrator, SqlClient } from "effect/sql"
import { boundedPool } from "./bounded.ts"
import { Authority, currentRanges } from "./shards.ts"
import { NekiTurnSessions } from "./neki/session.ts"
import {
  MigrationBarrier,
  MigrationBoundary,
  withMigrationCoordination,
} from "./neki/migrations.ts"

/** The deployment's unsharded authority, shared by every runner regardless of its data shard. */
export const Coordination = Context.Reference<SqlClient.SqlClient | undefined>(
  "@rikalabs/akter/runtime/database/coordination/Coordination",
  { defaultValue: () => undefined },
)

/**
 * The client for the data database's deployment registries and other tables
 * outside the routed group: its authority sessions while the map names data
 * shards, else the default client, which reaches the one database already.
 * With data shards it is a client of its own even for an untargeted fiber, so
 * a transaction on it never swallows the statements a fiber sends to a shard,
 * and a statement made inside a turn's transaction never reaches the shard's
 * copy of the table.
 */
export const registry = Effect.gen(function* () {
  if ((yield* currentRanges).some((range) => range.shard !== undefined)) {
    const sessions = yield* Authority

    if (sessions !== undefined) return sessions
  }

  return yield* SqlClient.SqlClient
})

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

/** Fixed, existence-guarded bootstrap steps can be replayed after any interrupted propagation. */
const prepareNekiCoordination = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const connection = yield* sql.reserve
  const barrier = yield* MigrationBarrier
  const boundary = yield* MigrationBoundary
  for (const [name, ddl] of [
    [
      "history",
      "CREATE TABLE IF NOT EXISTS actor_coordination_migrations (migration_id integer PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), name text NOT NULL)",
    ],
    ["resources", "CREATE TABLE IF NOT EXISTS actor_coordination (resource text PRIMARY KEY)"],
  ] as const) {
    yield* barrier(connection)
    yield* sql.unsafe(ddl)
    yield* boundary(`coordination:${name}:ddl`)
    yield* barrier(connection)
    yield* boundary(`coordination:${name}:propagated`)
  }
  yield* sql`INSERT INTO actor_coordination_migrations (migration_id, name)
    VALUES (1, 'coordination') ON CONFLICT (migration_id) DO NOTHING`
  yield* boundary("coordination:recorded")
})

/** Supplies an independent client so coordination transactions never borrow a data transaction's connection. */
export const coordinationLayer = (options: PgClient.PgPoolConfig | undefined) =>
  Layer.effect(
    Coordination,
    Effect.gen(function* () {
      if (options === undefined) return undefined
      const sql = yield* boundedPool(options)
      const neki = yield* NekiTurnSessions
      yield* withMigrationCoordination(
        neki
          ? prepareNekiCoordination
          : Migrator.make({})({
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
 * Work that writes no actor data, such as reading every data shard to accept
 * a deployment, passes `writesData: false` and holds no data transaction, so
 * its reads reach each shard instead of the one session a fence would pin.
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
