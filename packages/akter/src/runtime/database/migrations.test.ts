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
  30, 31, 32, 33, 34, 35,
]

/** Populated pre-upgrade rows and renamed constraints reject name guesses, data rewrites and broad FK removal. */
const hotTableUpgrade = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* migrator(Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0035")))
  yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id, generation)
    VALUES (-9137, 'hot-tenant', 'Counter', 'kept', 23)`
  yield* sql`INSERT INTO actor_state (routing_key, tenant_id, actor_type, actor_id, key, value)
    VALUES (-9137, 'hot-tenant', 'Counter', 'kept', 'count', decode('1731', 'hex'))`
  yield* sql`INSERT INTO actor_receipts (routing_key, tenant_id, actor_type, actor_id,
    command_id, command, payload_hash, caller_key, outcome, expires_at_ms)
    VALUES (-9137, 'hot-tenant', 'Counter', 'kept', 'retained-command', 'Add', 'hash',
      'caller', '{"value":47}', 987654321)`
  const foreignKeys = yield* sql<{ table_name: string; name: string }>`
    SELECT c.relname AS table_name, k.conname AS name FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    WHERE k.contype = 'f' AND k.confrelid = 'actor_generations'::regclass
      AND k.conrelid IN ('actor_state'::regclass, 'actor_receipts'::regclass)`
  expect(foreignKeys).toHaveLength(2)
  for (const fk of foreignKeys) {
    yield* sql`ALTER TABLE ${sql(fk.table_name)} RENAME CONSTRAINT ${sql(fk.name)}
      TO ${sql(`${fk.table_name}_generation_exact`)}`
  }
  yield* sql`CREATE TABLE upgrade_labels (key text PRIMARY KEY)`
  yield* sql`INSERT INTO upgrade_labels VALUES ('count')`
  yield* sql`ALTER TABLE actor_state ADD CONSTRAINT retained_label_fk
    FOREIGN KEY (key) REFERENCES upgrade_labels`
})

/** Physical tuples, catalogs and isolation policies must survive metadata-only maintenance unchanged. */
const hotTableSnapshot = (sql: SqlClient.SqlClient) =>
  Effect.all({
    state: sql`SELECT *, ctid::text, xmin::text FROM actor_state`,
    receipts: sql`SELECT *, ctid::text, xmin::text FROM actor_receipts`,
    generations: sql`SELECT *, ctid::text, xmin::text FROM actor_generations`,
    constraints: sql`SELECT conrelid::regclass::text AS table_name, conname,
      pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace
        AND conname NOT IN ('actor_state_generation_exact', 'actor_receipts_generation_exact')
      ORDER BY conrelid::regclass::text, conname`,
    indexes: schemaKeys(sql),
    policies: sql`SELECT * FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
    rls: sql`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid IN ('actor_state'::regclass, 'actor_receipts'::regclass) ORDER BY relname`,
  })

const generationForeignKeys = (sql: SqlClient.SqlClient) => sql`
  SELECT conname FROM pg_constraint WHERE contype = 'f'
    AND conrelid IN ('actor_state'::regclass, 'actor_receipts'::regclass)
    AND confrelid = 'actor_generations'::regclass ORDER BY conname`

describe("migrations with Postgres", () => {
  const runtime = ManagedRuntime.make(BunCrypto.layer)
  afterAll(() => runtime.dispose())

  it("upgrades populated hot tables by exact catalog identity, preserving rows, keys, RLS and other foreign keys", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* disposableDatabase({
            url: yield* Config.Redacted("TEST_DATABASE_URL"),
          })
          const client = yield* Layer.build(Database.postgres({ url }))
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* hotTableUpgrade
            const before = yield* hotTableSnapshot(sql)
            expect(yield* generationForeignKeys(sql)).toHaveLength(2)
            yield* migrator(migrations)
            expect(yield* generationForeignKeys(sql)).toEqual([])
            expect(yield* hotTableSnapshot(sql)).toEqual(before)
            expect(
              yield* sql`SELECT migration_id::int, name FROM actor_migrations WHERE migration_id = 35`,
            ).toEqual([{ migration_id: 35, name: "hot_table_foreign_keys" }])
            expect(
              yield* sql`SELECT tgname FROM pg_trigger WHERE tgisinternal
              AND tgrelid IN ('actor_state'::regclass, 'actor_receipts'::regclass)
              AND tgconstraint IN (SELECT oid FROM pg_constraint WHERE confrelid = 'actor_generations'::regclass)`,
            ).toEqual([])
            expect(yield* migrator(migrations)).toEqual([])
            expect(yield* hotTableSnapshot(sql)).toEqual(before)
          }).pipe(Effect.provideContext(client))
        }),
      ),
    ))

  it("rolls back the first hot-table FK drop when the second catalog identity is missing, then retries safely", () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* disposableDatabase({
            url: yield* Config.Redacted("TEST_DATABASE_URL"),
          })
          const client = yield* Layer.build(Database.postgres({ url }))
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* hotTableUpgrade
            yield* sql`ALTER TABLE actor_receipts DROP CONSTRAINT actor_receipts_generation_exact`
            const before = yield* hotTableSnapshot(sql)
            const failure = yield* migrator(migrations).pipe(Effect.exit)
            expect(Exit.isFailure(failure) && Cause.pretty(failure.cause)).toContain(
              "Expected exactly one generation foreign key on actor_receipts; found 0",
            )
            expect(yield* generationForeignKeys(sql)).toEqual([
              { conname: "actor_state_generation_exact" },
            ])
            expect(
              yield* sql`SELECT migration_id FROM actor_migrations WHERE migration_id = 35`,
            ).toEqual([])
            expect(yield* hotTableSnapshot(sql)).toEqual(before)
            yield* sql`ALTER TABLE actor_receipts ADD CONSTRAINT actor_receipts_generation_exact
              FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations`
            yield* migrator(migrations)
            expect(yield* generationForeignKeys(sql)).toEqual([])
            expect(yield* hotTableSnapshot(sql)).toEqual(before)
          }).pipe(Effect.provideContext(client))
        }),
      ),
    ))

  for (const release of [true, false]) {
    it(
      release
        ? "gives way after a bounded hot-table lock wait and retries once the blocker commits"
        : "exhausts bounded hot-table lock retries without a partial drop or migration record",
      { timeout: 100_000 },
      () =>
        runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const url = yield* disposableDatabase({
                url: yield* Config.Redacted("TEST_DATABASE_URL"),
              })
              const client = yield* Layer.build(Database.postgres({ url }))
              const pool = yield* Effect.acquireRelease(
                Effect.sync(() => new Pool({ connectionString: Redacted.value(url) })),
                (pool) => Effect.promise(() => pool.end()),
              )
              const blocker = yield* Effect.acquireRelease(
                Effect.promise(() => pool.connect()),
                (blocker) =>
                  Effect.promise(() => blocker.query("ROLLBACK")).pipe(
                    Effect.andThen(Effect.sync(() => blocker.release())),
                  ),
              )
              yield* Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient
                yield* hotTableUpgrade
                const before = yield* hotTableSnapshot(sql)
                yield* Effect.promise(() =>
                  blocker.query("BEGIN; LOCK TABLE actor_receipts IN ACCESS SHARE MODE"),
                )
                const started = performance.now()
                const upgrade = yield* migrator(migrations).pipe(Effect.exit, Effect.forkChild)
                const waiting = () =>
                  Effect.promise(() =>
                    pool.query<{ started: string }>(
                      "SELECT query_start::text AS started FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND query LIKE 'ALTER TABLE%actor_receipts%'",
                      [new URL(Redacted.value(url)).pathname.slice(1)],
                    ),
                  )
                const first = yield* waiting().pipe(
                  Effect.filterOrFail(
                    (result) => result.rows.length === 1,
                    () => "not waiting",
                  ),
                  Effect.retry({ times: 200, schedule: Schedule.spaced("25 millis") }),
                )
                yield* waiting().pipe(
                  Effect.filterOrFail(
                    (result) =>
                      result.rows.length === 1 &&
                      result.rows[0]!.started !== first.rows[0]!.started,
                    () => "not retried",
                  ),
                  Effect.retry({ times: 200, schedule: Schedule.spaced("25 millis") }),
                )
                expect(performance.now() - started).toBeGreaterThanOrEqual(2_000)
                if (release) yield* Effect.promise(() => blocker.query("COMMIT"))
                const result = yield* Fiber.join(upgrade)
                const elapsed = performance.now() - started
                if (release) {
                  expect(Exit.isSuccess(result)).toBe(true)
                  expect(yield* generationForeignKeys(sql)).toEqual([])
                  expect(
                    yield* sql`SELECT migration_id::int FROM actor_migrations WHERE migration_id = 35`,
                  ).toEqual([{ migration_id: 35 }])
                } else {
                  expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain(
                    "lock timeout",
                  )
                  expect(elapsed).toBeGreaterThanOrEqual(62_000)
                  expect(elapsed).toBeLessThan(90_000)
                  yield* Effect.promise(() => blocker.query("COMMIT"))
                  expect(yield* generationForeignKeys(sql)).toHaveLength(2)
                  expect(
                    yield* sql`SELECT migration_id FROM actor_migrations WHERE migration_id = 35`,
                  ).toEqual([])
                  yield* migrator(migrations)
                  expect(yield* generationForeignKeys(sql)).toEqual([])
                }
                expect(yield* hotTableSnapshot(sql)).toEqual(before)
                expect(yield* sql`SELECT current_setting('lock_timeout') AS timeout`).toEqual([
                  { timeout: "0" },
                ])
              }).pipe(Effect.provideContext(client))
            }),
          ),
        ),
    )
  }

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
                  Layer.provide(Database.postgres({ url, preset: "low-connection" })),
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
            expect(new Set(actorKeys.map((key) => key.table_name)).size).toBe(19)
            expect(actorKeys).toHaveLength(20)
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
