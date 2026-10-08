import { BunServices } from "@effect/platform-bun"
import { Config, Effect, ManagedRuntime, Redacted, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { disposableDatabase } from "../../../../../../packages/akter/src/testing/database.ts"

const counts = `SELECT
  (SELECT count(*)::int FROM actor_receipts WHERE command <> 'Note') AS receipts,
  (SELECT count(*)::int FROM crash_entries) AS rows,
  (SELECT count(*)::int FROM actor_events) AS events,
  (SELECT json_agg(command_id) FROM actor_receipts WHERE command <> 'Note') AS ids,
  (SELECT json_agg(intent_id) FROM actor_outbox) AS intents,
  (SELECT json_agg(command_id) FROM actor_receipts WHERE command = 'Note') AS delivered`

describe("owned rows across process death with Postgres", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  for (const [handler, point] of (["Append", "AppendThenRefuse"] as const).flatMap((handler) =>
    (["beforeCommit", "afterCommit"] as const).map((point) => [handler, point] as const),
  )) {
    const refused = handler === "AppendThenRefuse"

    it(
      refused
        ? `rolls back an owned row and its notifications before a declared failure across SIGKILL ${point} and replays the failure`
        : `leaves ${point === "beforeCommit" ? "no" : "one"} owned row after SIGKILL ${point} and retries to exactly one with one delivery`,
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

            const commandId = `v1.${now - 1_000}.${now - 1_000 + 86_400_000}.5d0c7f2e-7a0b-4f55-9d8e-2b1c6a3e4f10`

            const command = (mode: string) =>
              ChildProcess.make("bun", [new URL("./rows.ts", import.meta.url).pathname], {
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
            const staged = committed && !refused ? 1 : 0

            const before = (yield* Effect.promise(() => pool.query(counts))).rows
            expect(before).toEqual([
              {
                receipts: committed ? 1 : 0,
                rows: staged,
                events: staged,
                ids: committed ? [commandId] : null,
                intents: staged === 1 ? [expect.any(String)] : null,
                delivered: null,
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
              `{"reply":"${refused ? "Refused" : "1"}","handled":${committed ? 0 : 1},"noted":${refused ? 0 : 1},"receipts":1,"rows":${refused ? 0 : 1},"events":${refused ? 0 : 1}}`,
            ])

            const after = (yield* Effect.promise(() => pool.query(counts))).rows
            expect(after).toEqual([
              {
                receipts: 1,
                rows: refused ? 0 : 1,
                events: refused ? 0 : 1,
                ids: [commandId],
                intents: null,
                delivered: refused ? null : (before[0].intents ?? [expect.any(String)]),
              },
            ])
          }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
        ),
      25_000,
    )
  }
})
