import { BunCrypto } from "@effect/platform-bun"
import {
  Cause,
  Config,
  Crypto,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Schedule,
} from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { Database } from "../layer.ts"
import { migrations, migrator } from "./migrations.ts"
import { disposableDatabase } from "../../testing/database.ts"

/** Deployment registries and coordination rows are not actor data and stay in one shard group. */
const registries = [
  "actor_adoption_writes",
  "actor_adoptions",
  "actor_content_types",
  "actor_coordination",
  "actor_deployment",
  "actor_fleet_views",
  "actor_migrations",
  "actor_payload_versions",
  "actor_payload_writers",
  "actor_placements",
  "actor_routed_subscriptions",
  "actor_tables",
  "actor_workflow_manifests",
]

/** Includes standalone and partial unique indexes, which pg_constraint alone does not enumerate. */
const schemaKeys = (sql: SqlClient.SqlClient) => sql<{
  table_name: string
  index_name: string | null
  columns: Array<string> | null
}>`SELECT t.relname AS table_name, i.relname AS index_name,
    array_agg(a.attname::text ORDER BY k.ordinality) FILTER (WHERE a.attname IS NOT NULL) AS columns
  FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
  LEFT JOIN pg_index x ON x.indrelid = t.oid AND x.indisunique
  LEFT JOIN pg_class i ON i.oid = x.indexrelid
  LEFT JOIN LATERAL unnest(x.indkey) WITH ORDINALITY k(attnum, ordinality)
    ON k.ordinality <= x.indnkeyatts
  LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
  WHERE n.nspname = current_schema() AND t.relkind IN ('r', 'p')
    AND (t.relname LIKE 'actor\\_%' ESCAPE '\\' OR t.relname LIKE 'tenant\\_%' ESCAPE '\\')
  GROUP BY t.relname, i.relname ORDER BY t.relname, i.relname`

describe("migrations with Postgres", () => {
  const runtime = ManagedRuntime.make(BunCrypto.layer)
  afterAll(() => runtime.dispose())

  it("enumerates every framework primary and unique key, requires routing_key outside deployment registries, and finds no trigger or outside reference on per-actor tables", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* disposableDatabase({
            url: yield* Config.Redacted("TEST_DATABASE_URL"),
          })
          const client = yield* Layer.build(Database.postgres({ url }))

          yield* Effect.gen(function* () {
            yield* migrator(migrations)
            const sql = yield* SqlClient.SqlClient
            const keys = yield* schemaKeys(sql)
            const actorKeys = keys.filter((key) => !registries.includes(key.table_name))
            const violations = (rows: typeof keys) =>
              rows.filter(
                (key) =>
                  !registries.includes(key.table_name) &&
                  key.columns?.includes("routing_key") !== true,
              )

            expect([
              ...new Set(
                keys
                  .filter((key) => registries.includes(key.table_name))
                  .map((key) => key.table_name),
              ),
            ]).toEqual(registries)
            expect(new Set(actorKeys.map((key) => key.table_name)).size).toBe(18)
            expect(actorKeys).toHaveLength(19)
            expect(violations(keys)).toEqual([])
            expect(
              actorKeys.find((key) => key.index_name === "actor_outbox_timer")?.columns,
            ).toEqual(["routing_key", "tenant_id", "actor_type", "actor_id", "timer_key"])

            const actorTables = [...new Set(actorKeys.map((key) => key.table_name))]
            const triggers = sql<{ table_name: string; trigger: string }>`
              SELECT c.relname AS table_name, t.tgname AS trigger
              FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE NOT t.tgisinternal AND n.nspname = current_schema()
                AND c.relname IN ${sql.in(actorTables)}`
            expect(yield* triggers).toEqual([])
            const references = sql<{ child: string; parent: string }>`
              SELECT c.relname AS child, p.relname AS parent
              FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
              JOIN pg_class p ON p.oid = k.confrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE k.contype = 'f' AND n.nspname = current_schema()
                AND (c.relname IN ${sql.in(actorTables)} OR p.relname IN ${sql.in(actorTables)})`
            const outside = (rows: ReadonlyArray<{ child: string; parent: string }>) =>
              rows.filter(
                (reference) =>
                  !actorTables.includes(reference.child) || !actorTables.includes(reference.parent),
              )
            expect((yield* references).length).toBeGreaterThan(0)
            expect(outside(yield* references)).toEqual([])

            yield* sql`CREATE FUNCTION trigger_regression() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`
            yield* sql`CREATE TRIGGER trigger_regression AFTER INSERT ON actor_state FOR EACH ROW EXECUTE FUNCTION trigger_regression()`
            expect(yield* triggers).toEqual([
              { table_name: "actor_state", trigger: "trigger_regression" },
            ])
            yield* sql`CREATE TABLE reference_regression (id text PRIMARY KEY)`
            yield* sql`ALTER TABLE actor_state ADD COLUMN reference_regression text REFERENCES reference_regression (id)`
            expect(outside(yield* references)).toEqual([
              { child: "actor_state", parent: "reference_regression" },
            ])

            yield* sql`CREATE UNIQUE INDEX unkeyed_regression ON actor_outbox (intent_id)`
            expect(violations(yield* schemaKeys(sql))).toEqual([
              {
                table_name: "actor_outbox",
                index_name: "unkeyed_regression",
                columns: ["intent_id"],
              },
            ])
          }).pipe(Effect.provideContext(client))
        }),
      ),
    ))

  it("refuses to start when a concurrent runner commits a higher id while it waits for the migration lock", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
          const name = `migrations_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

          const admin = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: database.href })),
            (pool) => Effect.promise(() => pool.end()),
          )

          yield* Effect.acquireRelease(
            Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
            () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
          )
          database.pathname = `/${name}`

          const pool = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: database.href })),
            (db) => Effect.promise(() => db.end()),
          )

          const older = yield* Effect.acquireRelease(
            Effect.promise(() => pool.connect()),
            (client) => Effect.sync(() => client.release()),
          )

          const through9 = Object.fromEntries(
            Object.entries(migrations).filter(([id]) => id < "0010"),
          )

          const client = yield* Layer.build(
            Database.postgres({ url: Redacted.make(database.href) }),
          )

          const migrate = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
            Effect.provide(effect, client)

          yield* migrate(migrator(through9))

          yield* Effect.promise(() => older.query("BEGIN"))
          yield* Effect.promise(() =>
            older.query(
              "INSERT INTO actor_migrations (migration_id, name) VALUES (13, 'inspection_views')",
            ),
          )

          const newer = yield* Effect.forkChild(
            Effect.exit(
              migrate(
                migrator({
                  ...through9,
                  "0012_workflows": Effect.void,
                  "0013_inspection_views": Effect.void,
                }),
              ),
            ),
          )

          yield* Effect.promise(() =>
            pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
              [name],
            ),
          ).pipe(
            Effect.flatMap((result) =>
              result.rowCount === 0 ? Effect.fail("not waiting") : Effect.void,
            ),
            Effect.retry({ times: 200, schedule: Schedule.spaced("25 millis") }),
          )
          yield* Effect.promise(() => older.query("COMMIT"))

          const exit = yield* Fiber.join(newer)
          expect(Exit.isFailure(exit)).toBe(true)
          const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          expect(error).toBeInstanceOf(Migrator.MigrationError)
          expect(error).toMatchObject({
            kind: "BadState",
            message: expect.stringContaining(
              "Migrations 12 were never applied but migration 13 was",
            ),
          })
          expect(
            (yield* Effect.promise(() =>
              pool.query("SELECT migration_id FROM actor_migrations ORDER BY migration_id"),
            )).rows.map(({ migration_id }) => migration_id),
          ).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 13])
        }),
      ),
    ))

  it("records a parent type exactly for parent placement", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
          const name = `migrations_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

          const admin = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: database.href })),
            (pool) => Effect.promise(() => pool.end()),
          )

          yield* Effect.acquireRelease(
            Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
            () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
          )
          database.pathname = `/${name}`

          const client = yield* Layer.build(
            Database.postgres({ url: Redacted.make(database.href) }),
          )

          const migrate = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
            Effect.provide(effect, client)

          yield* migrate(migrator(migrations))

          const insert = (placement: string, parent: string | null) =>
            migrate(
              Effect.flatMap(
                SqlClient.SqlClient,
                (
                  sql,
                ) => sql`INSERT INTO actor_placements (actor_type, placement, encoding, parent_type)
                  VALUES (${`T${placement}${parent ?? ""}`}, ${placement}, 1, ${parent})`,
              ),
            ).pipe(Effect.exit)

          expect(Exit.isSuccess(yield* insert("actor", null))).toBe(true)
          expect(Exit.isSuccess(yield* insert("parent", "Tactor"))).toBe(true)
          expect(Exit.isFailure(yield* insert("parent", null))).toBe(true)
          expect(Exit.isFailure(yield* insert("actor", "Order"))).toBe(true)
          expect(Exit.isFailure(yield* insert("region", null))).toBe(true)
        }),
      ),
    ))
})
