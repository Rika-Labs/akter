import { BunServices } from "@effect/platform-bun"
import { Clock, Config, Effect, FileSystem, ManagedRuntime, Redacted, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { ColdStorage } from "../../../../../packages/akter/src/runtime/storage/cold-storage.ts"
import { disposableDatabase } from "../../../../../packages/akter/src/testing/database.ts"

const runtime = ManagedRuntime.make(BunServices.layer)
afterAll(() => runtime.dispose())

const offloads = ["afterSnapshot", "afterUpload", "afterFlip"]
const collectors = ["beforeDelete", "afterDelete"]
const points = [
  ...offloads,
  "afterColdRollback",
  "afterColdFetch",
  "afterColdWriteBack",
  "afterCommit",
  ...collectors,
]

describe("cold-tier transitions across SIGKILL with Postgres", () => {
  it.each(points)(
    "recovers exactly once after SIGKILL %s without losing material",
    (point) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const database = yield* disposableDatabase({
            url: yield* Config.Redacted("TEST_DATABASE_URL"),
          })
          const pool = yield* Effect.acquireRelease(
            Effect.sync(() => new Pool({ connectionString: Redacted.value(database), max: 1 })),
            (pool) => Effect.promise(() => pool.end()),
          )
          const fs = yield* FileSystem.FileSystem
          yield* fs.makeDirectory(".amp/in", { recursive: true })
          const directory = yield* fs.makeTempDirectoryScoped({
            directory: ".amp/in",
            prefix: "cold-crash-",
          })
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const now = (yield* Clock.currentTimeMillis) - 1000
          const id = `v1.${now}.${now + 86_400_000}.b20ae761-a9ba-4847-a1ec-3dba21d2a1e7`
          const offload = offloads.includes(point)
          const collector = collectors.includes(point)
          const command = (mode: string, boundary = "none") =>
            ChildProcess.make("bun", [new URL("./cold.ts", import.meta.url).pathname], {
              env: {
                CRASH_DATABASE_URL: Redacted.value(database),
                CRASH_STORE: directory,
                CRASH_MODE: mode,
                CRASH_POINT: boundary,
                CRASH_COMMAND_ID: id,
              },
              extendEnv: true,
              stderr: "inherit",
            })
          const setup = yield* spawner.spawn(
            command(offload ? "prepare-warm" : collector ? "prepare-garbage" : "prepare-cold"),
          )
          yield* setup.stdout.pipe(Stream.runDrain)
          expect(yield* setup.exitCode).toBe(0)
          const child = yield* spawner.spawn(
            command(offload ? "offload" : collector ? "collect" : "turn", point),
          )
          const ready = yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line === "READY"),
            Stream.take(1),
            Stream.runCollect,
          )
          expect(ready, "child must reach the actual durable boundary").toHaveLength(1)
          yield* child.kill({ killSignal: "SIGKILL" })
          expect(String((yield* child.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")
          const committed = point === "afterCommit" || collector
          const cold = point === "afterFlip" || (!offload && !committed)
          const before = (yield* Effect.promise(() =>
            pool.query(`SELECT
        (SELECT count(*)::int FROM actor_state) AS state,
        (SELECT count(*)::int FROM actor_blobs) AS chunks,
        (SELECT count(*)::int FROM actor_receipts) AS receipts,
        (SELECT count(*)::int FROM actor_events) AS events,
        (SELECT cold_ref IS NOT NULL FROM actor_generations) AS cold,
        (SELECT count(*)::int FROM actor_cold_garbage) AS garbage`),
          )).rows
          expect(before).toEqual([
            {
              state: cold ? 0 : 2,
              chunks: cold ? 0 : 3,
              receipts: committed ? 2 : 1,
              events: 1,
              cold,
              garbage: committed ? 1 : 0,
            },
          ])
          const store = yield* ColdStorage.filesystem(directory)
          expect(yield* store.list("").pipe(Stream.runCollect)).toHaveLength(
            point === "afterSnapshot" || point === "afterDelete" ? 0 : 1,
          )
          const recovery = yield* spawner.spawn(command(collector ? "recover-collect" : "recover"))
          const output = yield* recovery.stdout.pipe(Stream.decodeText(), Stream.mkString)
          expect(yield* recovery.exitCode, output).toBe(0)
          const line = output.split("\n").find((line) => line.startsWith("RESULT "))
          expect(line, output).toBeDefined()
          const result = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
            line!.slice(7),
          )
          expect(result).toEqual({
            reply: 24,
            snapshot: { total: 24, untouched: 43, first: "A|BC", second: "DZ" },
            state: 2,
            chunks: 3,
            receipts: 2,
            events: 1,
            cold: false,
            garbage: collector ? 0 : 1,
            objects: collector ? 0 : 1,
          })
        }).pipe(Effect.scoped, Effect.timeout("25 seconds")),
      ),
    30_000,
  )
})
