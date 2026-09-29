import { BunServices } from "@effect/platform-bun"
import { Config, Crypto, Effect, ManagedRuntime, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"

const stored = `SELECT
  (SELECT count(*)::int FROM actor_receipts WHERE actor_type = 'CrashLedger') AS receipts,
  (SELECT array_agg(sequence::int ORDER BY sequence) FROM actor_events) AS events,
  (SELECT event_sequence::int FROM actor_generations WHERE actor_type = 'CrashLedger') AS sequence`

describe("retention cleanup process death with Postgres", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  it(
    "leaves whole batches after a SIGKILL inside a sweep, and a fresh process finishes it",
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
          const name = `retention_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

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

          const command = (mode: string, commandId = "") =>
            ChildProcess.make("bun", [new URL("./retention.ts", import.meta.url).pathname], {
              env: {
                CRASH_DATABASE_URL: database.href,
                CRASH_POINT: mode,
                CRASH_COMMAND_ID: commandId,
              },
              extendEnv: true,
              stderr: "inherit",
            })

          const child = yield* spawner.spawn(command("crash"))

          const lines = yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line === "READY" || line.startsWith("ID ")),
            Stream.take(2),
            Stream.runCollect,
          )

          yield* child.kill({ killSignal: "SIGKILL" })
          expect(String((yield* child.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")
          const id = Array.from(lines)[0]!.slice("ID ".length)

          expect((yield* Effect.promise(() => pool.query(stored))).rows).toEqual([
            { receipts: 0, events: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12], sequence: 12 },
          ])

          const recovery = yield* spawner.spawn(command("recover", id))
          const output = yield* recovery.stdout.pipe(Stream.decodeText(), Stream.mkString)
          expect(yield* recovery.exitCode, output).toBe(0)

          expect(
            output
              .split("\n")
              .filter((line) => line.startsWith("RESULT "))
              .map((line) => JSON.parse(line.slice("RESULT ".length))),
          ).toEqual([{ sequence: "13", events: ["13"], retry: "CommandExpired", total: "21" }])
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
      ),
    35_000,
  )
})
