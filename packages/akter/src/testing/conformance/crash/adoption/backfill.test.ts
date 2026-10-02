import { BunCrypto, BunServices } from "@effect/platform-bun"
import { Config, Effect, Layer, ManagedRuntime, Redacted, Schedule, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { Actor } from "../../../../index.ts"
import { observeAdoption } from "../../../../runtime/adoption/observe.ts"
import { planAdoption } from "../../../../runtime/adoption/plan.ts"
import { migrate } from "../../../../runtime/database/migrations.ts"
import { Database } from "../../../../runtime/index.ts"
import { ActorTest } from "../../../actor-test.ts"
import { Shipment, Spread, Tenanted, actors, legacyDdl } from "./backfill.ts"
import { disposableDatabase } from "../../../database.ts"

const TENANT = "crash-tenant"

const HOLDERS = 40

const ROWS_PER_HOLDER = 50

const BATCH = 25

const touch = { Touch: () => Effect.void }

const live = Layer.mergeAll(
  Tenanted.toLayer(Effect.succeed(touch)),
  Spread.toLayer(Effect.succeed(touch)),
  Shipment.toLayer(Effect.succeed(touch)),
).pipe(Layer.provide(BunCrypto.layer))

describe("adoption backfill across process death with Postgres", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  it(
    "backfill matches routingKey for every placement, resumes after a SIGKILL between batches, and lists rows with NULL mapped columns",
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const database = new URL(
            Redacted.value(
              yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") }),
            ),
          )

          const pool = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: database.href })),
            (db) => Effect.promise(() => db.end()),
          )

          const setup = yield* Layer.build(Database.postgres({ url: Redacted.make(database.href) }))

          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* migrate

            for (const statement of legacyDdl) yield* sql.unsafe(statement)

            yield* sql.unsafe(`ALTER TABLE crash_adopt_tenant ALTER COLUMN holder DROP NOT NULL`)
            yield* observeAdoption(actors)

            for (const plan of yield* planAdoption(actors))
              yield* sql.unsafe(plan.indexSql!.replace("CONCURRENTLY ", ""))

            yield* sql`INSERT INTO crash_adopt_tenant (id, org, holder) VALUES
              ('t1', ${TENANT}, 'acct-1'), ('t2', ${TENANT}, 'acct-2'), ('t3', ${TENANT}, 'acct-1')`
            yield* sql`INSERT INTO crash_adopt_actor (id, org, holder)
              SELECT 'a' || h || '-' || n, ${TENANT}, 'p-' || h
              FROM generate_series(0, ${HOLDERS - 1}) AS h, generate_series(1, ${ROWS_PER_HOLDER}) AS n`
            yield* sql`INSERT INTO crash_adopt_child (id, org, holder) VALUES
              ('c1', ${TENANT}, ${Shipment.idOf("p-0", "s-1")}),
              ('c2', ${TENANT}, ${Shipment.idOf("p-7", "s-2")})`
          }).pipe(Effect.provideContext(setup))

          const keysOf = (table: string) =>
            Effect.promise(() =>
              pool.query(
                `SELECT holder, array_agg(DISTINCT routing_key::text) AS keys, count(*)::int AS rows,
                   count(routing_key)::int AS filled
                 FROM ${table} GROUP BY holder ORDER BY holder`,
              ),
            ).pipe(Effect.map((result) => result.rows))

          const actorContext = yield* Layer.build(
            live.pipe(
              Layer.provideMerge(
                ActorTest.layer({
                  database: Redacted.make(database.href),
                }),
              ),
              Layer.provide(BunCrypto.layer),
            ),
          )

          const expected = yield* Effect.gen(function* () {
            const scoped = Actor.tenant(TENANT)
            yield* (yield* Tenanted.get("acct-1").pipe(scoped)).Touch()
            yield* (yield* Tenanted.get("acct-2").pipe(scoped)).Touch()

            for (let holder = 0; holder < HOLDERS; holder++)
              yield* (yield* Spread.get(`p-${holder}`).pipe(scoped)).Touch()

            for (const id of [Shipment.idOf("p-0", "s-1"), Shipment.idOf("p-7", "s-2")])
              yield* (yield* Shipment.get(id).pipe(scoped)).Touch()

            const sql = yield* SqlClient.SqlClient

            return Object.fromEntries(
              (yield* sql<{ actor_id: string; routing_key: string }>`
                SELECT actor_id, routing_key::text AS routing_key FROM actor_generations
                WHERE tenant_id = ${TENANT}`).map((row) => [row.actor_id, row.routing_key]),
            )
          }).pipe(Effect.provideContext(actorContext))

          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

          const backfill = (table: string) =>
            ChildProcess.make("bun", [new URL("./backfill.ts", import.meta.url).pathname], {
              env: {
                CRASH_DATABASE_URL: database.href,
                ADOPT_ONLY: table,
                ADOPT_BATCH: String(BATCH),
              },
              extendEnv: true,
              stderr: "inherit",
            })

          const outcome = (table: string) =>
            Effect.gen(function* () {
              const child = yield* spawner.spawn(backfill(table))
              const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString)
              expect(yield* child.exitCode, output).toBe(0)

              return output
                .split("\n")
                .filter((line) => line.startsWith("RESULT ") || line.startsWith("REFUSED "))
            })

          yield* Effect.promise(() =>
            pool.query(
              `INSERT INTO crash_adopt_tenant (id, org, holder) VALUES ('bad1', '${TENANT}', NULL), ('bad2', '${TENANT}', '')`,
            ),
          )

          const [refused] = yield* outcome("crash_adopt_tenant")
          expect(refused).toContain(
            "REFUSED public.crash_adopt_tenant has rows whose org or holder is NULL or empty",
          )
          expect(refused).toContain("(bad1) (bad2)")
          expect(
            (yield* Effect.promise(() =>
              pool.query(
                `SELECT count(*)::int AS n FROM crash_adopt_tenant WHERE routing_key IS NOT NULL`,
              ),
            )).rows,
          ).toEqual([{ n: 0 }])

          yield* Effect.promise(() =>
            pool.query(`DELETE FROM crash_adopt_tenant WHERE id IN ('bad1', 'bad2')`),
          )

          yield* Effect.promise(() =>
            pool.query(
              `CREATE FUNCTION crash_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.03); RETURN NULL; END $$`,
            ),
          )
          yield* Effect.promise(() =>
            pool.query(
              `CREATE TRIGGER crash_pause BEFORE UPDATE ON crash_adopt_actor FOR EACH STATEMENT EXECUTE FUNCTION crash_pause()`,
            ),
          )

          const child = yield* spawner.spawn(backfill("crash_adopt_actor"))

          const total = HOLDERS * ROWS_PER_HOLDER

          const filled = () =>
            Effect.promise(() =>
              pool.query(`SELECT count(routing_key)::int AS n FROM crash_adopt_actor`),
            ).pipe(Effect.map((result) => result.rows[0].n as number))

          yield* filled().pipe(
            Effect.flatMap((n) => (n > 0 ? Effect.void : Effect.fail("waiting"))),
            Effect.retry({ times: 2000, schedule: Schedule.spaced("5 millis") }),
          )
          yield* child.kill({ killSignal: "SIGKILL" })
          expect(String((yield* child.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")

          const survived = yield* filled()
          expect(survived, "the child finished before it was killed").toBeLessThan(total)
          expect(survived).toBeGreaterThan(0)
          expect(survived % BATCH, "a batch was applied in part").toBe(0)

          yield* Effect.promise(() => pool.query(`DROP TRIGGER crash_pause ON crash_adopt_actor`))

          const [resumed] = yield* outcome("crash_adopt_actor")

          const decoded = yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Array(
                Schema.Struct({ table: Schema.String, filled: Schema.Int, passes: Schema.Int }),
              ),
            ),
          )(resumed!.slice("RESULT ".length))

          expect(decoded).toEqual([
            { table: "public.crash_adopt_actor", filled: total - survived, passes: 2 },
          ])

          for (const [table, holders] of [
            ["crash_adopt_actor", null],
            ["crash_adopt_tenant", "tenant"],
            ["crash_adopt_child", "child"],
          ] as const) {
            if (holders !== null) yield* outcome(table)

            const rows = yield* keysOf(table)

            expect(rows.length).toBeGreaterThan(0)

            for (const row of rows) {
              expect(row.filled).toBe(row.rows)
              expect(row.keys).toEqual([expected[row.holder]])
            }
          }

          expect(new Set(Object.values(expected)).size).toBeGreaterThan(HOLDERS)
        }).pipe(Effect.scoped, Effect.timeout("90 seconds")),
      ),
    100_000,
  )
})
