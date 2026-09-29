import { BunServices } from "@effect/platform-bun"
import { Config, Crypto, Effect, ManagedRuntime, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"

// Each effect's letter checks the cause its executor reported.
const counts = `SELECT
  (SELECT count(*)::int FROM actor_receipts WHERE command IN ('Order', 'Measure')) AS ordered,
  (SELECT count(*)::int FROM actor_receipts WHERE command LIKE '%Failed') AS routed,
  (SELECT coalesce(sum(calls), 0)::int FROM provider_calls) AS calls,
  (SELECT json_agg(json_build_array(attempts, ambiguous, CASE effect
      WHEN 'Charge' THEN cause LIKE '%ProviderDown%'
      ELSE cause LIKE '%onSuccess route cannot accept%' END))
    FROM actor_dead_letters) AS letters,
  (SELECT json_agg(json_build_array(kind, command, attempts)) FROM actor_outbox) AS outbox`

describe("effect dead-letter process death with Postgres", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  // At each point: the dead letters, route receipts, and outbox row the killed
  // process leaves, then the letter recovery writes. Inside the dead-letter
  // transaction nothing of it commits; after it, the letter is recorded and
  // the row is already the route's intent, which stays until the route's
  // receiver has committed and the row is deleted. A gauge's rejected result
  // is final with two retries left, which recovery must not spend on the
  // provider; its row's `final_attempt` marks it exhausted.
  for (const [name, effect, point, letters, routed, row, letter] of [
    [
      "an exhausted effect",
      "Charge",
      "beforeDeadLetterCommit",
      null,
      0,
      ["effect", "Charge", 1],
      [1, false, true],
    ],
    [
      "an exhausted effect",
      "Charge",
      "beforeDelivery",
      [[1, false, true]],
      0,
      ["intent", "ChargeFailed", 1],
      [1, false, true],
    ],
    [
      "an exhausted effect",
      "Charge",
      "beforeCommit",
      [[1, false, true]],
      0,
      ["intent", "ChargeFailed", 1],
      [1, false, true],
    ],
    [
      "an exhausted effect",
      "Charge",
      "beforeOutboxDelete",
      [[1, false, true]],
      1,
      ["intent", "ChargeFailed", 1],
      [1, false, true],
    ],
    [
      "a final failure with retries left",
      "Gauge",
      "beforeDeadLetterCommit",
      null,
      0,
      ["effect", "Gauge", 1],
      [1, true, true],
    ],
  ] as const) {
    it(
      `recovers a SIGKILL ${point} of ${name} with one dead letter and one route`,
      () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
            const name = `deadletters_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

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
              ChildProcess.make("bun", [new URL("./deadletters.ts", import.meta.url).pathname], {
                env: { CRASH_DATABASE_URL: database.href, CRASH_POINT: mode, CRASH_EFFECT: effect },
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

            // The buyer committed its effect and the provider saw its only attempt.
            expect((yield* Effect.promise(() => pool.query(counts))).rows).toEqual([
              { ordered: 1, routed, calls: 1, letters, outbox: [row] },
            ])

            const recovery = yield* spawner.spawn(command("recover"))
            const output = yield* recovery.stdout.pipe(Stream.decodeText(), Stream.mkString)
            expect(yield* recovery.exitCode, output).toBe(0)

            const [effectId] = (yield* Effect.promise(() =>
              pool.query<{ idempotency_key: string }>("SELECT idempotency_key FROM provider_calls"),
            )).rows.map(({ idempotency_key }) => idempotency_key)

            // Recovery settles from the recorded outcome without calling the
            // provider again, and the route's command id is the effect id. A
            // route that had committed replays its receipt, so the state
            // counts one failure either way.
            expect(
              output
                .split("\n")
                .filter((line) => line.startsWith("RESULT "))
                .map((line) => line.slice("RESULT ".length)),
            ).toEqual([`{"routedId":"${effectId}","state":"1"}`])
            expect((yield* Effect.promise(() => pool.query(counts))).rows).toEqual([
              { ordered: 1, routed: 1, calls: 1, letters: [letter], outbox: null },
            ])
          }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
        ),
      25_000,
    )
  }
})
