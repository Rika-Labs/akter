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
import { Actors, Database } from "../index.ts"
import { migrations, migrator } from "./migrations.ts"
import { disposableDatabase } from "../../testing/database.ts"
import { AUTHORITY_MOVED_TABLES } from "../storage/placements.ts"

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

const expectedIds = [
  1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25, 26, 27, 29,
  30, 31, 32, 33,
]

describe("migrations with Postgres", () => {
  const runtime = ManagedRuntime.make(BunCrypto.layer)
  afterAll(() => runtime.dispose())

  it("starts six Actors.layer runners together on a completely fresh database", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const url = yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
        yield* Effect.forEach(
          Array.from({ length: 6 }),
          () =>
            Effect.scoped(
              Layer.build(
                Actors.layer().pipe(
                  Layer.provide(
                    Database.postgres({ url, offTurnConnections: 2, maxConnections: 1 }),
                  ),
                ),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        )
        const client = yield* Layer.build(Database.postgres({ url }))
        const sql = yield* Effect.provideContext(SqlClient.SqlClient, client)
        expect(
          (yield* sql<{
            id: number
          }>`SELECT migration_id::int AS id FROM actor_migrations ORDER BY migration_id`).map(
            ({ id }) => id,
          ),
        ).toEqual(expectedIds)
        expect(yield* sql`SELECT to_regclass('actor_migration_steps')::text AS journal`).toEqual([
          { journal: null },
        ])
      }).pipe(Effect.scoped),
    ))

  it("serializes six fresh processes with an independent coordination database", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const server = yield* Config.Redacted("TEST_DATABASE_URL")
        const url = yield* disposableDatabase({ url: server })
        const coordination = yield* disposableDatabase({ url: server })
        const layerUrl = new URL("../index.ts", import.meta.url).href
        const code = `
          import { BunCrypto } from "@effect/platform-bun";
          import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
          import { Actors, Database } from "${layerUrl}";
          const runtime = ManagedRuntime.make(Actors.layer().pipe(
            Layer.provide(Database.postgres({
              url: Redacted.make(process.env.START_DATA), maxConnections: 1, offTurnConnections: 2,
              coordination: { url: Redacted.make(process.env.START_AUTHORITY), maxConnections: 2 }
            })), Layer.provide(BunCrypto.layer)));
          try { await runtime.runPromise(Effect.void); } finally { await runtime.dispose(); }
        `
        yield* Effect.forEach(
          Array.from({ length: 6 }),
          () =>
            Effect.gen(function* () {
              const child = yield* Effect.acquireRelease(
                Effect.sync(() =>
                  Bun.spawn([process.execPath, "-e", code], {
                    env: {
                      ...process.env,
                      START_DATA: Redacted.value(url),
                      START_AUTHORITY: Redacted.value(coordination),
                    },
                    stdout: "ignore",
                    stderr: "pipe",
                  }),
                ),
                (child) => Effect.sync(() => child.kill()),
              )
              const [exitCode, stderr] = yield* Effect.promise(() =>
                Promise.all([child.exited, new Response(child.stderr).text()]),
              )
              expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
            }),
          { concurrency: "unbounded", discard: true },
        )
        const data = yield* Layer.build(Database.postgres({ url }))
        const control = yield* Layer.build(Database.postgres({ url: coordination }))
        const sql = yield* Effect.provideContext(SqlClient.SqlClient, data)
        const authority = yield* Effect.provideContext(SqlClient.SqlClient, control)
        expect(
          (yield* sql<{
            id: number
          }>`SELECT migration_id::int AS id FROM actor_migrations ORDER BY migration_id`).map(
            ({ id }) => id,
          ),
        ).toEqual(expectedIds)
        expect(
          yield* authority`SELECT migration_id::int, name FROM actor_coordination_migrations`,
        ).toEqual([{ migration_id: 1, name: "coordination" }])
        expect(
          yield* authority`SELECT to_regclass('cluster_runners')::text AS runners, to_regclass('actor_migrations')::text AS data`,
        ).toEqual([{ runners: "cluster_runners", data: null }])
        expect(
          yield* sql`SELECT to_regclass('cluster_runners')::text AS runners, to_regclass('actor_coordination_migrations')::text AS control`,
        ).toEqual([{ runners: null, control: null }])
      }).pipe(Effect.scoped),
    ))

  it("rolls back a blocked inspection-view retirement, then upgrades and restarts without losing actor rows", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const url = yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") })
        yield* Layer.build(Database.postgres({ url })).pipe(
          Effect.flatMap((client) =>
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* migrator(
                Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0033")),
              )
              yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id, generation)
            VALUES (-9123, 'upgrade-tenant', 'Ledger', 'kept', 17)`
              yield* sql`CREATE VIEW inspection_dependency AS SELECT * FROM durable.actors_v2`
              const before = yield* sql`SELECT * FROM durable.views ORDER BY view_name`
              expect(Exit.isFailure(yield* migrator(migrations).pipe(Effect.exit))).toBe(true)
              expect(yield* sql`SELECT * FROM durable.views ORDER BY view_name`).toEqual(before)
              expect(
                yield* sql`SELECT migration_id::int FROM actor_migrations WHERE migration_id = 33`,
              ).toEqual([])
              expect(
                yield* sql`SELECT count(*)::int AS views FROM pg_views WHERE schemaname = 'durable' AND viewname LIKE '%\_v2' ESCAPE '\'`,
              ).toEqual([{ views: 15 }])
              yield* sql`DROP VIEW inspection_dependency`
              yield* migrator(migrations)
              yield* migrator(migrations)
              expect(
                yield* sql`SELECT count(*)::int AS views FROM pg_views WHERE schemaname = 'durable' AND viewname LIKE '%\_v2' ESCAPE '\'`,
              ).toEqual([{ views: 0 }])
              expect(
                yield* sql`SELECT actor_id, generation::int FROM durable.actors WHERE tenant_id = 'upgrade-tenant'`,
              ).toEqual([{ actor_id: "kept", generation: 17 }])
              expect(
                yield* sql`SELECT migration_id::int, name FROM actor_migrations WHERE migration_id = 33`,
              ).toEqual([{ migration_id: 33, name: "joined_inspection" }])
              expect(yield* sql`SELECT count(*)::int AS views FROM durable.views`).toEqual([
                { views: 14 },
              ])
            }).pipe(Effect.provideContext(client)),
          ),
          Effect.scoped,
        )
        const restarted = yield* Layer.build(
          Actors.layer().pipe(Layer.provideMerge(Database.postgres({ url }))),
        )
        const sql = yield* Effect.provideContext(SqlClient.SqlClient, restarted)
        expect(
          yield* sql`SELECT actor_id, generation::int FROM durable.actors WHERE tenant_id = 'upgrade-tenant'`,
        ).toEqual([{ actor_id: "kept", generation: 17 }])
        expect(yield* sql`SELECT count(*)::int AS views FROM durable.views`).toEqual([
          { views: 14 },
        ])
      }).pipe(Effect.scoped),
    ))

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
            expect([...AUTHORITY_MOVED_TABLES].sort()).toEqual(
              actorTables.filter((table) => !table.startsWith("tenant_")).sort(),
            )
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

  it("records a parent type exactly for parent placement, and authority placement without one", () =>
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
          expect(Exit.isSuccess(yield* insert("authority", null))).toBe(true)
          expect(Exit.isFailure(yield* insert("authority", "Tactor"))).toBe(true)
        }),
      ),
    ))
})
