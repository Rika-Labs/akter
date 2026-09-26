import { BunServices } from "@effect/platform-bun"
import { Config, Crypto, Effect, ManagedRuntime, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"

describe("blobs across process death with Postgres", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  // `AppendThenRefuse` appends a chunk and then fails with a declared error, so
  // only its terminal receipt may commit.
  for (const [handler, point] of (["Append", "AppendThenRefuse"] as const).flatMap((handler) =>
    (["beforeCommit", "afterCommit"] as const).map((point) => [handler, point] as const),
  )) {
    const refused = handler === "AppendThenRefuse"

    it(
      refused
        ? `rolls back a blob chunk before a declared failure across SIGKILL ${point} and replays the failure`
        : `leaves ${point === "beforeCommit" ? "no" : "one"} blob chunk after SIGKILL ${point} and retries to exactly one`,
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
            const name = `blobs_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

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

            const now = Number(
              (yield* Effect.promise(() =>
                pool.query(
                  "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now",
                ),
              )).rows[0].now,
            )

            const commandId = `v1.${now - 1_000}.${now - 1_000 + 86_400_000}.5d0c7f2e-7a0b-4f55-9d8e-2b1c6a3e4f10`

            const command = (mode: string) =>
              ChildProcess.make("bun", [new URL("./blobs.ts", import.meta.url).pathname], {
                env: {
                  CRASH_DATABASE_URL: database.href,
                  CRASH_POINT: mode,
                  CRASH_COMMAND_ID: commandId,
                  CRASH_COMMAND: handler,
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

            const committed = point === "afterCommit" ? 1 : 0

            // A separate pool sees only what the killed process committed.
            expect(
              (yield* Effect.promise(() =>
                pool.query(
                  "SELECT (SELECT count(*)::int FROM actor_receipts) AS receipts, (SELECT count(*)::int FROM actor_blobs) AS chunks, (SELECT json_agg(command_id) FROM actor_receipts) AS ids",
                ),
              )).rows,
            ).toEqual([
              {
                receipts: committed,
                chunks: refused ? 0 : committed,
                ids: committed === 1 ? [commandId] : null,
              },
            ])

            const recovery = yield* spawner.spawn(command("recover"))
            const output = yield* recovery.stdout.pipe(Stream.decodeText(), Stream.mkString)
            expect(yield* recovery.exitCode, output).toBe(0)
            expect(
              output
                .split("\n")
                .filter((line) => line.startsWith("RESULT "))
                .map((line) => line.slice("RESULT ".length)),
            ).toEqual([
              `{"reply":"${refused ? "Refused" : "5"}","handled":${committed === 1 ? 0 : 1},"receipts":1,"chunks":${refused ? 0 : 1}}`,
            ])
          }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
        ),
      25_000,
    )
  }
})
