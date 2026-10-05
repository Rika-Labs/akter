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

/**
 * A database whose propagation barrier counts its calls and refuses to run
 * inside a writing transaction, and which refuses DDL once its transaction
 * has written. Plain Postgres shows DDL inside a transaction, so this rejects
 * a transactional runner only where Neki would lose its DDL; it is not Neki.
 */
const standIn = Effect.gen(function* () {
  const url = yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: Redacted.value(url) })),
    (pool) => Effect.promise(() => pool.end()),
  )
  yield* Effect.promise(() =>
    pool.query(`
      CREATE SCHEMA __neki;
      CREATE TABLE neki_barriers (calls integer NOT NULL);
      INSERT INTO neki_barriers VALUES (0);
      CREATE TABLE ledger (at serial PRIMARY KEY, entry text NOT NULL);
      CREATE FUNCTION __neki.ddl_versions(OUT schema_version bigint, OUT cluster_version bigint)
        LANGUAGE sql AS $$ SELECT 1::bigint, 1::bigint $$;
      CREATE FUNCTION __neki.wait_for_ddl(schema_version bigint, cluster_version bigint)
        RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
          RAISE EXCEPTION 'DDL propagation was requested inside a writing transaction';
        END IF;
        UPDATE neki_barriers SET calls = calls + 1;
      END $$;
      CREATE FUNCTION neki_autocommit_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
          RAISE EXCEPTION 'DDL inside a writing transaction: %', tg_tag;
        END IF;
      END $$;
      CREATE EVENT TRIGGER neki_autocommit_ddl ON ddl_command_start
        EXECUTE FUNCTION neki_autocommit_ddl();
    `),
  )
  const scalar = (text: string) =>
    Effect.promise(() => pool.query<{ value: unknown }>(text)).pipe(
      Effect.map(({ rows }) => rows[0]?.value),
    )
  return { url, scalar }
})

const client = (url: Redacted.Redacted<string>, neki: boolean) =>
  Layer.build(
    PgClient.layer({ url, maxConnections: 2 }).pipe(
      Layer.merge(Layer.succeed(Database.Neki, neki)),
    ),
  )

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
        const { url, scalar } = yield* standIn
        yield* scalar("DROP EVENT TRIGGER neki_autocommit_ddl")
        const exit = yield* Effect.exit(
          twoTablesThenFail.pipe(
            Database.schemaChange(41),
            Effect.provideContext(yield* client(url, false)),
          ),
        )

        expect(exit).toEqual(Exit.fail("stopped"))
        expect(yield* scalar(tables)).toBe(0)
        expect(yield* scalar("SELECT count(*)::int AS value FROM ledger")).toBe(0)
        expect(yield* scalar("SELECT calls AS value FROM neki_barriers")).toBe(0)
      }).pipe(Effect.scoped),
    ))

  it("autocommits each Neki statement and waits for propagation after every DDL", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const { url, scalar } = yield* standIn
        const exit = yield* Effect.exit(
          twoTablesThenFail.pipe(
            Database.schemaChange(41),
            Effect.provideContext(yield* client(url, true)),
          ),
        )

        expect(exit).toEqual(Exit.fail("stopped"))
        expect(yield* scalar(tables)).toBe(2)
        expect(yield* scalar("SELECT count(*)::int AS value FROM ledger")).toBe(1)
        expect(yield* scalar("SELECT calls AS value FROM neki_barriers")).toBe(3)
      }).pipe(Effect.scoped),
    ))

  it("lets one Neki process at a time hold the same lock", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const { url, scalar } = yield* standIn
        const setup = (name: string, context: Context.Context<SqlClient.SqlClient>) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`INSERT INTO ledger (entry) VALUES (${`${name}:start`})`
            yield* Effect.sleep("150 millis")
            yield* sql`INSERT INTO ledger (entry) VALUES (${`${name}:end`})`
          }).pipe(Database.schemaChange(42), Effect.provideContext(context))
        yield* Effect.all(
          [setup("a", yield* client(url, true)), setup("b", yield* client(url, true))],
          { concurrency: "unbounded" },
        )

        const order = (yield* scalar(
          "SELECT string_agg(entry, ',' ORDER BY at) AS value FROM ledger",
        )) as string
        expect(["a:start,a:end,b:start,b:end", "b:start,b:end,a:start,a:end"]).toContain(order)
      }).pipe(Effect.scoped),
    ))
})
