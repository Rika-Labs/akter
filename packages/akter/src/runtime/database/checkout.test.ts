import { PgClient } from "@effect/sql-pg"
import {
  Cause,
  Config,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Queue,
  Schedule,
} from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { Database } from "../layer.ts"
import { TurnConnections } from "../turn/pipeline.ts"
import { fairLayer } from "./checkout.ts"
import { Coordination } from "./coordination.ts"
import { QueryPool, ReadReplica } from "./replica.ts"

/**
 * Runs `callers` loops of `step` for `durationMs` and counts each loop's
 * completed steps. A pool that lets the fiber freeing a connection take it
 * again leaves every caller beyond the pool's size at zero.
 */
const contend = <E>(callers: number, durationMs: number, step: Effect.Effect<unknown, E>) =>
  Effect.gen(function* () {
    const counts = Array.from({ length: callers }, () => 0)
    const deadline = performance.now() + durationMs

    yield* Effect.forEach(
      counts,
      (_, caller) =>
        Effect.gen(function* () {
          while (performance.now() < deadline) {
            yield* step
            counts[caller]! += 1
          }
        }),
      { concurrency: "unbounded", discard: true },
    )

    return counts
  })

describe("first-come, first-served pools with Postgres", () => {
  const runtime = ManagedRuntime.make(Layer.empty)
  afterAll(() => runtime.dispose())

  it("keeps every caller moving on each runtime pool when callers outnumber connections", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* Config.Redacted("TEST_DATABASE_URL")
          const context = yield* Layer.build(
            Database.postgres({
              url,
              maxConnections: 2,
              offTurnConnections: 2,
              queryConnections: 2,
              replica: { url, maxConnections: 2 },
              coordination: { url, maxConnections: 2 },
            }),
          )
          const offTurn = Context.get(context, SqlClient.SqlClient)
          const queries = Context.get(context, QueryPool)!
          const replica = Context.get(context, ReadReplica)!
          const coordination = Context.get(context, Coordination)!
          const turns = Context.get(context, TurnConnections)

          const counts = yield* Effect.all(
            [
              contend(24, 1500, offTurn`SELECT 1`),
              contend(24, 1500, queries`SELECT 1`),
              contend(24, 1500, replica`SELECT 1`),
              contend(24, 1500, coordination`SELECT 1`),
              contend(
                24,
                1500,
                Effect.scoped(
                  Effect.flatMap(turns.lease, (connection) => connection.query("SELECT 1")),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          )

          for (const pool of counts) expect(Math.min(...pool)).toBeGreaterThan(10)
        }),
      ),
    ))

  it("fails a COMMIT that Postgres answers with ROLLBACK, as a Postgres client does", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* Config.Redacted("TEST_DATABASE_URL")
          const sql = Context.get(
            yield* Layer.build(fairLayer({ url, maxConnections: 2 })),
            SqlClient.SqlClient,
          )

          const exit = yield* sql
            .withTransaction(sql`SELECT 1 / 0`.pipe(Effect.ignore))
            .pipe(Effect.exit)
          const aborted = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

          expect(SqlError.isSqlError(aborted) && aborted.reason._tag).toBe("UnknownError")
          expect(yield* sql<{ one: number }>`SELECT 1 AS one`).toEqual([{ one: 1 }])
        }),
      ),
    ))

  it("isolates nested failures, releases savepoints, and commits only the surviving writes", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* Config.Redacted("TEST_DATABASE_URL")
          const sql = Context.get(
            yield* Layer.build(fairLayer({ url, maxConnections: 1 })),
            SqlClient.SqlClient,
          )
          yield* sql`CREATE TEMP TABLE checkout_savepoints (value integer)`
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO checkout_savepoints VALUES (11)`
              const failure = yield* sql
                .withTransaction(
                  sql`INSERT INTO checkout_savepoints VALUES (17)`.pipe(
                    Effect.andThen(sql`SELECT 1 / 0`),
                  ),
                )
                .pipe(Effect.exit)
              expect(Exit.isFailure(failure)).toBe(true)
              yield* sql.withTransaction(sql`INSERT INTO checkout_savepoints VALUES (23)`)
              yield* sql`INSERT INTO checkout_savepoints VALUES (31)`
            }),
          )
          expect(yield* sql`SELECT value FROM checkout_savepoints ORDER BY value`).toEqual([
            { value: 11 },
            { value: 23 },
            { value: 31 },
          ])

          for (const failed of [false, true]) {
            const exit = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql
                    .withTransaction(failed ? Effect.fail("nested failure") : Effect.void)
                    .pipe(Effect.ignore)
                  yield* sql.unsafe("RELEASE SAVEPOINT effect_sql_1")
                }),
              )
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
            expect(SqlError.isSqlError(error) && error.reason.cause).toMatchObject({
              code: "3B001",
            })
          }
          expect(yield* sql`SELECT count(*)::int AS count FROM checkout_savepoints`).toEqual([
            { count: 3 },
          ])
        }),
      ),
    ))

  it.each([false, true])(
    "cancels an interrupted statement and returns a clean single-connection pool (transaction: %s)",
    (transaction) =>
      runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const url = yield* Config.Redacted("TEST_DATABASE_URL")
            const applicationName = `checkout-interrupt-${transaction}`
            const connectionString = yield* Config.String("TEST_DATABASE_URL")
            const sql = Context.get(
              yield* Layer.build(fairLayer({ url, maxConnections: 1, applicationName })),
              SqlClient.SqlClient,
            )
            const observer = yield* Effect.acquireRelease(
              Effect.sync(() => new Pool({ connectionString, max: 1 })),
              (pool) => Effect.promise(() => pool.end()),
            )
            yield* sql`CREATE TEMP TABLE checkout_interrupt (value integer)`
            const statement = transaction
              ? sql.withTransaction(
                  sql`INSERT INTO checkout_interrupt VALUES (47)`.pipe(
                    Effect.andThen(sql`SELECT pg_sleep(60)`),
                  ),
                )
              : sql`SELECT pg_sleep(60)`
            const running = yield* Effect.forkChild(statement)
            yield* Effect.promise(() =>
              observer.query(
                "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND state = 'active' AND wait_event = 'PgSleep'",
                [applicationName],
              ),
            ).pipe(
              Effect.flatMap((result) =>
                result.rowCount === 1 ? Effect.void : Effect.fail("not sleeping"),
              ),
              Effect.retry({ times: 200, schedule: Schedule.spaced("10 millis") }),
            )

            yield* Fiber.interrupt(running).pipe(Effect.timeout("10 seconds"))
            const exit = yield* Fiber.await(running)
            expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
            expect(
              yield* sql`SELECT value FROM checkout_interrupt`.pipe(Effect.timeout("2 seconds")),
            ).toEqual([])
            yield* sql.withTransaction(sql`INSERT INTO checkout_interrupt VALUES (59)`)
            expect(yield* sql`SELECT value FROM checkout_interrupt`).toEqual([{ value: 59 }])
            const sleeping = yield* Effect.promise(() =>
              observer.query(
                "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND state = 'active' AND wait_event = 'PgSleep'",
                [applicationName],
              ),
            )
            expect(sleeping.rowCount).toBe(0)
          }),
        ),
      ),
  )

  it("notifies outside the current transaction and rejects channels exceeding 63 UTF-8 bytes", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* Config.Redacted("TEST_DATABASE_URL")
          const client = Context.get(
            yield* Layer.build(fairLayer({ url, maxConnections: 2 })),
            PgClient.PgClient,
          )
          const listener = Context.get(
            yield* Layer.build(fairLayer({ url, maxConnections: 1 })),
            PgClient.PgClient,
          )
          const channel = "checkout-notify"
          const notifications = yield* listener.listen(channel)
          const exit = yield* client
            .withTransaction(
              Effect.gen(function* () {
                yield* client.notify(channel, "outside")
                expect(
                  yield* Queue.take(notifications).pipe(Effect.timeout("2 seconds")),
                ).toMatchObject({
                  channel,
                  payload: "outside",
                })
                return yield* Effect.fail("rollback")
              }),
            )
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe("rollback")
          const invalid = yield* client.notify("é".repeat(32), "rejected").pipe(Effect.exit)
          const error = Exit.isFailure(invalid) ? Cause.squash(invalid.cause) : undefined
          expect(SqlError.isSqlError(error) && error.reason._tag).toBe("UnknownError")
          yield* client.notify(`${"é".repeat(31)}x`, "accepted")
        }),
      ),
    ))
})
