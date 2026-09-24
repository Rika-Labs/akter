import { BunServices } from "@effect/platform-bun"
import { Cause, Config, Crypto, Effect, Exit, ManagedRuntime, Redacted, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { migrate } from "../../../runtime/database/migrations.ts"
import { Database } from "../../../runtime/index.ts"

describe("process death with Postgres", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  it("rolls back partial foundation DDL and safely reruns the migration", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
        const name = `migration_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

        const admin = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: database.href })),
          (pool) => Effect.promise(() => pool.end()),
        )

        yield* Effect.acquireRelease(
          Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
          () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
        )
        database.pathname = `/${name}`

        const sqlRuntime = yield* Effect.acquireRelease(
          Effect.sync(() =>
            ManagedRuntime.make(Database.postgres({ url: Redacted.make(database.href) })),
          ),
          (db) => Effect.promise(() => db.dispose()),
        )

        yield* Effect.promise(() =>
          sqlRuntime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`CREATE TABLE actor_state (collision boolean)`
              const failure = yield* migrate.pipe(Effect.exit)
              expect(Exit.isFailure(failure) && Cause.pretty(failure.cause)).toContain(
                "actor_state",
              )
              expect(
                yield* sql`SELECT to_regclass('actor_generations')::text AS generations, to_regclass('actor_deployment')::text AS deployment`,
              ).toEqual([{ generations: null, deployment: null }])
              expect(yield* sql`SELECT migration_id FROM actor_migrations`).toEqual([])
              yield* sql`DROP TABLE actor_state`
              yield* migrate
              expect(yield* sql`SELECT migration_id FROM actor_migrations`).toEqual([
                { migration_id: 1 },
                { migration_id: 2 },
                { migration_id: 3 },
                { migration_id: 4 },
                { migration_id: 5 },
              ])
              expect(yield* sql`SELECT count(*)::int AS receipts FROM actor_receipts`).toEqual([
                { receipts: 0 },
              ])
              expect(yield* migrate).toEqual([])
            }),
          ),
        )
      }).pipe(Effect.scoped),
    ))

  for (const point of ["beforeCommit", "afterCommit"] as const) {
    it(
      `recovers SIGKILL ${point} by retrying the same command id in a new process`,
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
            const name = `crash_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

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

            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

            // One identity, minted from the database clock and reused by the recovery process.
            const now = Number(
              (yield* Effect.promise(() =>
                pool.query(
                  "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now",
                ),
              )).rows[0].now,
            )

            const commandId = `v1.${now - 1_000}.${now - 1_000 + 86_400_000}.17b3670b-3f17-4a9b-aade-037e1dd1bba8`

            const command = (mode: string) =>
              ChildProcess.make("bun", [new URL("./main.ts", import.meta.url).pathname], {
                env: {
                  CRASH_DATABASE_URL: database.href,
                  CRASH_POINT: mode,
                  CRASH_COMMAND_ID: commandId,
                },
                extendEnv: true,
                stderr: "inherit",
              })

            const child = yield* spawner.spawn(command(point))
            yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.filter((line) => line === "READY"),
              Stream.take(1),
              Stream.runCollect,
            )
            yield* child.kill({ killSignal: "SIGKILL" })
            expect(String((yield* child.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")

            const before = yield* Effect.promise(() =>
              pool.query(
                "SELECT (SELECT count(*)::int FROM actor_receipts) AS receipts, (SELECT count(*)::int FROM actor_state) AS state",
              ),
            )

            expect(before.rows).toEqual([
              { receipts: point === "afterCommit" ? 1 : 0, state: point === "afterCommit" ? 1 : 0 },
            ])
            expect(
              (yield* Effect.promise(() =>
                pool.query("SELECT to_regclass('cluster_messages')::text AS messages"),
              )).rows,
            ).toEqual([{ messages: null }])
            const recovery = yield* spawner.spawn(command("recover"))
            const output = yield* recovery.stdout.pipe(Stream.decodeText(), Stream.mkString)
            expect(yield* recovery.exitCode, output).toBe(0)
            expect(
              output
                .split("\n")
                .filter((line) => line.startsWith("RESULT "))
                .map((line) => line.slice("RESULT ".length)),
            ).toEqual(['{"value":47,"receipts":1,"state":"47"}'])

            const after = yield* Effect.promise(() =>
              pool.query("SELECT count(*)::int AS receipts FROM actor_receipts"),
            )

            expect(after.rows).toEqual([{ receipts: 1 }])
          }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
        ),
      25_000,
    )
  }
})
