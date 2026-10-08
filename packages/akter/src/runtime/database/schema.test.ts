import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { Config, type Context, Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { disposableDatabase } from "../../testing/database.ts"
import { Database } from "../layer.ts"

const harness = ManagedRuntime.make(BunCrypto.layer)
afterAll(() => harness.dispose())

/** A disposable real database for schema rollback and advisory-lock serialization. */
const database = Effect.gen(function* () {
  const url = yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: Redacted.value(url) })),
    (pool) => Effect.promise(() => pool.end()),
  )
  yield* Effect.promise(() =>
    pool.query("CREATE TABLE ledger (at serial PRIMARY KEY, entry text NOT NULL)"),
  )
  const scalar = (text: string) =>
    Effect.promise(() => pool.query<{ value: unknown }>(text)).pipe(
      Effect.map(({ rows }) => rows[0]?.value),
    )
  return { url, scalar }
})

const client = (url: Redacted.Redacted<string>) =>
  Layer.build(PgClient.layer({ url, maxConnections: 2 }))

const twoTablesThenFail = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE first_change (id int)`
  yield* sql`INSERT INTO ledger (entry) VALUES ('between')`
  yield* sql`CREATE TABLE second_change (id int)`
  return yield* Effect.fail("stopped" as const)
})

const tables =
  "SELECT count(*)::int AS value FROM pg_class WHERE relname IN ('first_change', 'second_change')"

describe("Database.schemaChange", () => {
  it("keeps the Postgres setup in one transaction, so a failure removes all of it", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const { url, scalar } = yield* database
        const exit = yield* Effect.exit(
          twoTablesThenFail.pipe(
            Database.schemaChange(41),
            Effect.provideContext(yield* client(url)),
          ),
        )

        expect(exit).toEqual(Exit.fail("stopped"))
        expect(yield* scalar(tables)).toBe(0)
        expect(yield* scalar("SELECT count(*)::int AS value FROM ledger")).toBe(0)
      }).pipe(Effect.scoped),
    ))

  it("lets one independent Postgres client at a time hold the same lock", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const { url, scalar } = yield* database
        const setup = (name: string, context: Context.Context<SqlClient.SqlClient>) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`INSERT INTO ledger (entry) VALUES (${`${name}:start`})`
            yield* Effect.sleep("150 millis")
            yield* sql`INSERT INTO ledger (entry) VALUES (${`${name}:end`})`
          }).pipe(Database.schemaChange(42), Effect.provideContext(context))
        yield* Effect.all([setup("a", yield* client(url)), setup("b", yield* client(url))], {
          concurrency: "unbounded",
        })

        const order = (yield* scalar(
          "SELECT string_agg(entry, ',' ORDER BY at) AS value FROM ledger",
        )) as string
        expect(["a:start,a:end,b:start,b:end", "b:start,b:end,a:start,a:end"]).toContain(order)
      }).pipe(Effect.scoped),
    ))
})
