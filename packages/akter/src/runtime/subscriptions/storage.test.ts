import { BunCrypto } from "@effect/platform-bun"
import { Config, Crypto, Effect, Exit, Fiber, Layer, ManagedRuntime, Redacted, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { Pool, type PoolClient } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { Database } from "../layer.ts"
import { migrate } from "../database/migrations.ts"
import { changeRows, rowColumns } from "./storage.ts"

const KEY = 42n

const SOURCE = `routing_key = ${KEY} AND tenant_id = 't' AND source_type = 'Src' AND source_id = 's'`

/** A fresh migrated database whose source has one active row per subscriber, each counted once. */
const withRows = <A, E>(
  rows: ReadonlyArray<readonly [subscriber: string, event: string]>,
  body: (
    clients: readonly [PoolClient, PoolClient],
    watcher: Pool,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | Crypto.Crypto>,
) =>
  Effect.gen(function* () {
    const url = new URL(yield* Config.String("TEST_DATABASE_URL"))
    const name = `tags_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

    const admin = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: url.href })),
      (pool) => Effect.promise(() => pool.end()),
    )

    yield* Effect.acquireRelease(
      Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
      () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
    )
    url.pathname = `/${name}`

    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: url.href })),
      (db) => Effect.promise(() => db.end()),
    )

    const connect = Effect.acquireRelease(
      Effect.promise(() => pool.connect()),
      (client) => Effect.sync(() => client.release()),
    )

    const clients = [yield* connect, yield* connect] as const
    const client = yield* Layer.build(Database.postgres({ url: Redacted.make(url.href) }))

    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrate
      yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
        VALUES (${KEY}, 't', 'Src', 's')`

      for (const [subscriber, event] of rows) {
        yield* sql`INSERT INTO actor_subscriptions (routing_key, tenant_id, source_type, source_id,
            subscriber_type, subscription, subscriber_id, events, epoch, active, delivered, bucket)
          VALUES (${KEY}, 't', 'Src', 's', 'Sub', 'Follows', ${subscriber}, ARRAY[${event}], 1, true, 0, 0)`
        yield* sql`INSERT INTO actor_subscription_tags (routing_key, tenant_id, source_type,
            source_id, event, rows) VALUES (${KEY}, 't', 'Src', 's', ${event}, 1)`
      }

      return yield* body(clients, pool)
    }).pipe(Effect.provideContext(client))
  })

/** Moves `subscriber`'s row to follow `event` alone, through `changeRows`. */
const follow = (subscriber: string, event: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const row = sql`${sql.literal(SOURCE)} AND subscriber_type = 'Sub' AND subscription = 'Follows'
      AND subscriber_id = ${subscriber}`

    return yield* changeRows(
      sql`SELECT ${rowColumns({ sql, alias: "s" })} FROM actor_subscriptions s WHERE ${row} FOR UPDATE`,
      sql`UPDATE actor_subscriptions s SET events = ARRAY[${event}] WHERE ${row}
        RETURNING ${rowColumns({ sql, alias: "s" })}`,
    )
  })

/** Polls `query` on `watcher` every 10 ms until `until` accepts its rows. */
const poll = <R extends object>(
  watcher: Pool,
  query: string,
  params: ReadonlyArray<unknown>,
  until: (rows: ReadonlyArray<R>) => boolean,
) =>
  Effect.promise(() => watcher.query<R>(query, [...params])).pipe(
    Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: (result) => until(result.rows) }),
    Effect.timeout("10 seconds"),
    Effect.orDie,
    Effect.map((result) => result.rows),
  )

/** Opens a transaction on `holder` that locks the summary row of `event`, returning its backend's pid. */
const hold = (holder: PoolClient, event: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => holder.query("BEGIN"))
    yield* Effect.promise(() =>
      holder.query(
        `SELECT 1 FROM actor_subscription_tags WHERE ${SOURCE} AND event = $1 FOR UPDATE`,
        [event],
      ),
    )

    const result = yield* Effect.promise(() =>
      holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
    )

    return result.rows[0]!.pid
  })

/**
 * Swaps the tags of `first` (cancelled to placed) and `second` (placed to
 * cancelled) while each summary row is held by its own transaction, then
 * frees the cancelled row and, once `first` waits past it for the placed
 * row, the placed row. `first` and `second` each lower one count and raise
 * the other, so a writer that locks its decrements before its increments
 * takes them in opposite orders: `second` is queued on the placed row first,
 * wins it, and waits on the cancelled row `first` holds while `first` waits
 * on it. Writers that lock every count in one key order queue behind each
 * other instead. Returns each change's exit.
 */
const swapUnderHolders = (clients: readonly [PoolClient, PoolClient], watcher: Pool) =>
  Effect.gen(function* () {
    const [cancelled, placed] = clients
    const cancelledHolder = yield* hold(cancelled, "OrderCancelled")
    yield* hold(placed, "OrderPlaced")

    const first = yield* Effect.forkChild(follow("first", "OrderPlaced").pipe(Effect.exit))

    const [waiter] = yield* poll<{ pid: number }>(
      watcher,
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
      [cancelledHolder],
      (rows) => rows.length > 0,
    )

    const second = yield* Effect.forkChild(follow("second", "OrderCancelled").pipe(Effect.exit))

    yield* poll<{ pid: number }>(
      watcher,
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
      [],
      (rows) => rows.length === 2,
    )

    yield* Effect.promise(() => cancelled.query("COMMIT"))

    yield* poll<{ blockers: Array<number> }>(
      watcher,
      "SELECT pg_blocking_pids($1) AS blockers",
      [waiter!.pid],
      ([row]) => row!.blockers.length > 0 && !row!.blockers.includes(cancelledHolder),
    )

    yield* Effect.promise(() => placed.query("COMMIT"))

    return [yield* Fiber.join(first), yield* Fiber.join(second)]
  })

describe("subscription tag summary with Postgres", () => {
  const runtime = ManagedRuntime.make(BunCrypto.layer)
  afterAll(() => runtime.dispose())

  it("moves two rows that swap their tags concurrently without deadlocking on the summary", () =>
    runtime.runPromise(
      Effect.scoped(
        withRows(
          [
            ["first", "OrderCancelled"],
            ["second", "OrderPlaced"],
          ],
          (clients, watcher) =>
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const exits = yield* swapUnderHolders(clients, watcher)
              expect(exits.map(Exit.isSuccess)).toEqual([true, true])

              const counted = yield* sql<{ event: string; rows: number }>`SELECT x.tag AS event,
                  count(*)::int AS rows
                FROM actor_subscriptions, unnest(events) AS x(tag)
                WHERE ${sql.literal(SOURCE)} AND active GROUP BY x.tag ORDER BY x.tag`

              expect(counted).toEqual([
                { event: "OrderCancelled", rows: 1 },
                { event: "OrderPlaced", rows: 1 },
              ])
              expect(
                yield* sql<{ event: string; rows: number }>`SELECT event, rows
                  FROM actor_subscription_tags WHERE ${sql.literal(SOURCE)} ORDER BY event`,
              ).toEqual(counted)
            }),
        ),
      ),
    ))
})
