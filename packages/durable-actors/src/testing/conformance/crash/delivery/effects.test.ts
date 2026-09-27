import { BunServices } from "@effect/platform-bun"
import { Config, Crypto, Effect, ManagedRuntime, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"

const counts = `SELECT
  (SELECT count(*)::int FROM actor_receipts WHERE command = 'Post') AS posted,
  (SELECT count(*)::int FROM actor_receipts WHERE command = 'Moderated') AS routed,
  (SELECT coalesce(sum(calls), 0)::int FROM provider_calls) AS calls,
  (SELECT json_agg(json_build_array(kind, attempts)) FROM actor_outbox) AS outbox`

describe("effect executor process death with Postgres", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  // At each point: the provider calls and outbox row the killed process leaves,
  // and the provider calls after a fresh process recovers the effect. `attempts`
  // counts claims, so the route the relay claimed before the kill shows 1.
  for (const [point, calls, row, recovered] of [
    ["beforeExecute", 0, ["effect", 1], 1],
    ["afterExecute", 1, ["effect", 1], 2],
    ["beforeCommit", 1, ["intent", 1], 1],
  ] as const) {
    it(
      `recovers a SIGKILL ${point} and routes onSuccess once per effect id`,
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
            const name = `effects_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

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

            yield* Effect.promise(() =>
              pool.query(
                "CREATE TABLE provider_calls (idempotency_key text PRIMARY KEY, calls int NOT NULL)",
              ),
            )

            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

            const command = (mode: string) =>
              ChildProcess.make("bun", [new URL("./effects.ts", import.meta.url).pathname], {
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

            // The author committed its effect; nothing was routed yet.
            expect((yield* Effect.promise(() => pool.query(counts))).rows).toEqual([
              { posted: 1, routed: 0, calls, outbox: [row] },
            ])

            const recovery = yield* spawner.spawn(command("recover"))
            const output = yield* recovery.stdout.pipe(Stream.decodeText(), Stream.mkString)
            expect(yield* recovery.exitCode, output).toBe(0)

            const [effectId] = (yield* Effect.promise(() =>
              pool.query<{ idempotency_key: string }>("SELECT idempotency_key FROM provider_calls"),
            )).rows.map(({ idempotency_key }) => idempotency_key)

            // Every provider call used the effect id, which is also the route's command id.
            expect(
              output
                .split("\n")
                .filter((line) => line.startsWith("RESULT "))
                .map((line) => line.slice("RESULT ".length)),
            ).toEqual([`{"receipts":1,"routedId":"${effectId}","state":"1"}`])
            expect((yield* Effect.promise(() => pool.query(counts))).rows).toEqual([
              { posted: 1, routed: 1, calls: recovered, outbox: null },
            ])
          }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
        ),
      25_000,
    )
  }
})
