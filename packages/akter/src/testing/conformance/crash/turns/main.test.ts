import { BunServices } from "@effect/platform-bun"
import { Cause, Config, Effect, Exit, ManagedRuntime, Redacted, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { migrate } from "../../../../runtime/database/migrations.ts"
import { Database } from "../../../../runtime/index.ts"
import { disposableDatabase } from "../../../database.ts"

describe("process death with Postgres", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  it("rolls back partial foundation DDL and safely reruns the migration", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const database = new URL(
          Redacted.value(
            yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") }),
          ),
        )

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
                { migration_id: 6 },
                { migration_id: 8 },
                { migration_id: 9 },
                { migration_id: 10 },
                { migration_id: 11 },
                { migration_id: 12 },
                { migration_id: 13 },
                { migration_id: 14 },
                { migration_id: 15 },
                { migration_id: 16 },
                { migration_id: 17 },
                { migration_id: 18 },
                { migration_id: 20 },
                { migration_id: 21 },
                { migration_id: 22 },
                { migration_id: 23 },
                { migration_id: 24 },
                { migration_id: 25 },
                { migration_id: 26 },
                { migration_id: 27 },
                { migration_id: 29 },
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
            const database = new URL(
              Redacted.value(
                yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") }),
              ),
            )

            const pool = yield* Effect.acquireRelease(
              Effect.sync(() => new Pool({ connectionString: database.href })),
              (db) => Effect.promise(() => db.end()),
            )

            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

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

            const ready = yield* child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.filter((line) => line === "READY"),
              Stream.take(1),
              Stream.runCollect,
            )

            expect(ready, "the child exited before reaching its crash point").toHaveLength(1)
            yield* child.kill({ killSignal: "SIGKILL" })
            expect(String((yield* child.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")

            const before = yield* Effect.promise(() =>
              pool.query(
                "SELECT (SELECT count(*)::int FROM actor_receipts) AS receipts, (SELECT count(*)::int FROM actor_state) AS state, (SELECT count(*)::int FROM actor_events) AS events",
              ),
            )

            const committed = point === "afterCommit" ? 1 : 0
            expect(before.rows).toEqual([
              { receipts: committed, state: committed, events: committed },
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
            ).toEqual(['{"value":47,"receipts":1,"events":1,"state":"47"}'])

            const after = yield* Effect.promise(() =>
              pool.query(
                "SELECT (SELECT count(*)::int FROM actor_receipts) AS receipts, (SELECT count(*)::int FROM actor_events) AS events",
              ),
            )

            expect(after.rows).toEqual([{ receipts: 1, events: 1 }])
          }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
        ),
      25_000,
    )
  }
})
