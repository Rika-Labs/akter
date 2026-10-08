import { BunServices } from "@effect/platform-bun"
import { Config, Effect, ManagedRuntime, Redacted, Schedule, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { decompress } from "../../../../../../packages/akter/src/runtime/storage/codec.ts"
import { disposableDatabase } from "../../../../../../packages/akter/src/testing/database.ts"

const uuids = [
  "4b7c1f0e-8a52-4f0e-9d0b-1f6c2b9a7e31",
  "a3d2e7c4-1b6f-4c8e-b0a9-5d7e3f2c1a64",
  "e9f1a6b3-7c2d-4e5f-8a1b-3c4d5e6f7a82",
]

/**
 * Kills a runner whose three warm actors' turns share one group, at the
 * moment `mode` names, then checks the database and retries every command id
 * in a new process. `crash` kills it with the members' writes handed over and
 * unsent; `commit` kills it while the group's `COMMIT` waits on an advisory
 * lock this test holds, then lets that `COMMIT` finish without its client.
 */
const drill = (mode: "crash" | "commit") =>
  Effect.gen(function* () {
    const database = new URL(
      Redacted.value(
        yield* disposableDatabase({ url: yield* Config.Redacted("TEST_DATABASE_URL") }),
      ),
    )

    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: database.href, max: 2 })),
      (db) => Effect.promise(() => db.end()),
    )

    const query = (text: string, values?: ReadonlyArray<unknown>) =>
      Effect.promise(() => pool.query(text, values === undefined ? undefined : [...values]))

    const holder = yield* Effect.acquireRelease(
      Effect.promise(() => pool.connect()),
      (client) => Effect.sync(() => client.release()),
    )

    if (mode === "commit")
      yield* Effect.promise(() => holder.query("SELECT pg_advisory_lock(4950)"))

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const now = Number(
      (yield* query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now"))
        .rows[0].now,
    )
    const ids = uuids.map((uuid) => `v1.${now - 1_000}.${now - 1_000 + 86_400_000}.${uuid}`)

    const command = (run: string) =>
      ChildProcess.make("bun", [new URL("./groups.ts", import.meta.url).pathname], {
        env: {
          CRASH_DATABASE_URL: database.href,
          CRASH_MODE: run,
          CRASH_COMMAND_IDS: ids.join(","),
        },
        extendEnv: true,
        stderr: "inherit",
      })

    const child = yield* spawner.spawn(command(mode))

    if (mode === "crash") {
      const ready = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line === "READY"),
        Stream.take(1),
        Stream.runCollect,
      )

      expect(ready, "the child exited before its group held every member").toHaveLength(1)
    } else
      yield* query(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory' AND upper(query) LIKE 'COMMIT%'",
      ).pipe(
        Effect.flatMap((result) =>
          result.rows[0].waiting === 1 ? Effect.void : Effect.fail("COMMIT not waiting yet"),
        ),
        Effect.retry(Schedule.spaced("50 millis")),
      )

    const open = yield* query(
      "SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = current_database() AND backend_xid IS NOT NULL AND pid <> pg_backend_pid()",
    )
    expect(open.rows, "one transaction holds the whole group").toEqual([{ open: 1 }])

    yield* child.kill({ killSignal: "SIGKILL" })
    expect(String((yield* child.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")

    const receipts = () =>
      query(
        "SELECT count(*)::int AS receipts, count(DISTINCT xmin::text)::int AS transactions FROM actor_receipts WHERE command_id = ANY($1)",
        [ids],
      )

    expect((yield* receipts()).rows).toEqual([{ receipts: 0, transactions: 0 }])

    if (mode === "commit") {
      yield* Effect.promise(() => holder.query("SELECT pg_advisory_unlock(4950)"))
      yield* receipts().pipe(
        Effect.flatMap((result) =>
          result.rows[0].receipts > 0 ? Effect.void : Effect.fail("COMMIT not done yet"),
        ),
        Effect.retry(Schedule.spaced("50 millis")),
      )
    }

    const committed = mode === "commit"
    expect((yield* receipts()).rows).toEqual([
      { receipts: committed ? 3 : 0, transactions: committed ? 1 : 0 },
    ])

    const counts = (yield* query(
      "SELECT actor_id, value FROM actor_state WHERE actor_type = 'GroupCrashCounter' AND key = 'count' ORDER BY actor_id",
    )).rows.map((row: { actor_id: string; value: Uint8Array }) => [
      row.actor_id,
      decompress(row.value),
    ])
    const count = committed ? "11" : "1"
    expect(counts).toEqual([
      ["member-0", count],
      ["member-1", count],
      ["member-2", count],
    ])

    const recovery = yield* spawner.spawn(command("recover"))
    const output = yield* recovery.stdout.pipe(Stream.decodeText(), Stream.mkString)
    expect(yield* recovery.exitCode, output).toBe(0)
    expect(
      output
        .split("\n")
        .filter((line) => line.startsWith("RESULT "))
        .map((line) => line.slice("RESULT ".length)),
    ).toEqual(["[11,11,11]"])

    const after = yield* query(
      "SELECT command_id, count(*)::int AS receipts FROM actor_receipts WHERE command_id = ANY($1) GROUP BY command_id ORDER BY command_id",
      [ids],
    )
    expect(after.rows).toEqual(
      [...ids].sort().map((commandId) => ({ command_id: commandId, receipts: 1 })),
    )
  }).pipe(Effect.scoped, Effect.timeout("40 seconds"))

describe("process death inside a turn group", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  it(
    "leaves every member of an uncommitted group absent, and each retry in a new process commits once",
    () => runtime.runPromise(drill("crash")),
    45_000,
  )

  it(
    "commits every member of a group whose COMMIT was sent before the process died, and each retry answers from its receipt",
    () => runtime.runPromise(drill("commit")),
    45_000,
  )
})
