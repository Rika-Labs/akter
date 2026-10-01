import { BunServices } from "@effect/platform-bun"
import { Config, Effect, ManagedRuntime, Redacted, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { disposableDatabase } from "../../../database.ts"

const counts = `SELECT
  (SELECT count(*)::int FROM actor_receipts WHERE command = 'Send') AS sent,
  (SELECT count(*)::int FROM actor_receipts WHERE command = 'Add') AS received,
  (SELECT count(*)::int FROM actor_outbox) AS outbox`

describe("outbox relay process death with Postgres", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  for (const [point, received] of [
    ["beforeDelivery", 0],
    ["beforeCommit", 0],
    ["beforeOutboxDelete", 1],
  ] as const) {
    it(
      `recovers a SIGKILL ${point} from actor_outbox with one receiver transition`,
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

            const command = (mode: string) =>
              ChildProcess.make("bun", [new URL("./relay.ts", import.meta.url).pathname], {
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

            expect((yield* Effect.promise(() => pool.query(counts))).rows).toEqual([
              { sent: 1, received, outbox: 1 },
            ])

            const recovery = yield* spawner.spawn(command("recover"))
            const output = yield* recovery.stdout.pipe(Stream.decodeText(), Stream.mkString)
            expect(yield* recovery.exitCode, output).toBe(0)
            expect(
              output
                .split("\n")
                .filter((line) => line.startsWith("RESULT "))
                .map((line) => line.slice("RESULT ".length)),
            ).toEqual(['{"receipts":1,"state":"5"}'])
            expect((yield* Effect.promise(() => pool.query(counts))).rows).toEqual([
              { sent: 1, received: 1, outbox: 0 },
            ])
          }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
        ),
      25_000,
    )
  }
})
