import { BunServices } from "@effect/platform-bun"
import { Config, Crypto, Effect, ManagedRuntime, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"

const counts = `SELECT (SELECT count(*)::int FROM actor_receipts) AS receipts,
  (SELECT count(*)::int FROM actor_state WHERE key = 'count') AS state,
  (SELECT json_agg(command_id) FROM actor_receipts) AS ids`

describe("reducer turns across process death with Postgres", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  for (const [amount, reply, state, point] of (
    [
      [5, "5", '"5"'],
      [1000, "Overflow", "null"],
    ] as const
  ).flatMap((outcome) =>
    (["beforeCommit", "afterCommit"] as const).map((point) => [...outcome, point] as const),
  )) {
    const outcome = reply === "Overflow" ? "declared failure" : "state change"

    it(
      `recovers a reducer ${outcome} after SIGKILL ${point} by retrying the same command id`,
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
            const name = `reducers_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

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

            const commandId = `v1.${now - 1_000}.${now - 1_000 + 86_400_000}.0c4f9d8e-51a2-4b7c-8e3d-6f2a1b9c7d40`

            const command = (mode: string) =>
              ChildProcess.make("bun", [new URL("./reducers.ts", import.meta.url).pathname], {
                env: {
                  CRASH_DATABASE_URL: database.href,
                  CRASH_POINT: mode,
                  CRASH_COMMAND_ID: commandId,
                  CRASH_AMOUNT: String(amount),
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

            const committed = point === "afterCommit"
            expect((yield* Effect.promise(() => pool.query(counts))).rows).toEqual([
              {
                receipts: committed ? 1 : 0,
                state: committed && reply !== "Overflow" ? 1 : 0,
                ids: committed ? [commandId] : null,
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
              `{"reply":"${reply}","reductions":${committed ? 0 : 1},"receipts":1,"state":${state}}`,
            ])
            expect((yield* Effect.promise(() => pool.query(counts))).rows).toEqual([
              {
                receipts: 1,
                state: reply === "Overflow" ? 0 : 1,
                ids: [commandId],
              },
            ])
          }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
        ),
      25_000,
    )
  }
})
