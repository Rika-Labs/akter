import { Cause, Config, Context, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { afterAll, describe, expect, it } from "vitest"
import { Database } from "../layer.ts"
import { TurnConnections } from "../turn/pipeline.ts"
import { fairLayer } from "./checkout.ts"
import { QueryPool } from "./replica.ts"

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
            }),
          )
          const offTurn = Context.get(context, SqlClient.SqlClient)
          const queries = Context.get(context, QueryPool)!
          const turns = Context.get(context, TurnConnections)

          const counts = yield* Effect.all(
            [
              contend(24, 1500, offTurn`SELECT 1`),
              contend(24, 1500, queries`SELECT 1`),
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
})
