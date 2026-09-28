import { BunServices } from "@effect/platform-bun"
import { Config, Crypto, Effect, ManagedRuntime, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"

const counts = `SELECT
  (SELECT count(*)::int FROM actor_events WHERE event = 'Posted') AS posted,
  (SELECT count(*)::int FROM actor_receipts WHERE command = 'Record') AS applied,
  (SELECT count(*)::int FROM actor_subscriptions WHERE due_at_ms IS NOT NULL) AS claimed`

describe("subscription relay process death with Postgres", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  for (const [point, applied] of [
    ["beforeCommit", 0],
    ["beforeSettle", 1],
  ] as const) {
    it(
      `applies each committed source event once across a SIGKILL ${point} of the subscriber's commit`,
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
            const name = `subscriptions_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

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

            const command = (mode: string) =>
              ChildProcess.make("bun", [new URL("./subscriptions.ts", import.meta.url).pathname], {
                env: { CRASH_DATABASE_URL: database.href, CRASH_POINT: mode },
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

            // The source's event committed; the subscriber only past its own commit,
            // and the killed relay's claim is still held.
            expect((yield* Effect.promise(() => pool.query(counts))).rows).toEqual([
              { posted: 1, applied, claimed: 1 },
            ])

            const recovery = yield* spawner.spawn(command("recover"))
            const output = yield* recovery.stdout.pipe(Stream.decodeText(), Stream.mkString)
            expect(yield* recovery.exitCode, output).toBe(0)
            expect(
              output
                .split("\n")
                .filter((line) => line.startsWith("RESULT "))
                .map((line) => line.slice("RESULT ".length)),
            ).toEqual(['{"receipts":1,"state":"1"}'])
            expect((yield* Effect.promise(() => pool.query(counts))).rows).toEqual([
              { posted: 1, applied: 1, claimed: 0 },
            ])
          }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
        ),
      25_000,
    )
  }
})
