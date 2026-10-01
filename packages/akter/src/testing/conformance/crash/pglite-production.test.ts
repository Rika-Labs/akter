import { BunServices } from "@effect/platform-bun"
import {
  Cause,
  Clock,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Layer,
  ManagedRuntime,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { afterAll, describe, expect, it } from "vitest"
import { DataDirLocked, DataDirVersion } from "../../../errors/database.ts"
import { LOCK_FILE, POSTGRES_MAJOR } from "../../../runtime/database/pglite.ts"
import { Database } from "../../../runtime/index.ts"

const entry = new URL("./pglite-production.ts", import.meta.url).pathname

describe("file-backed PGlite as an embedded production backend", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Crypto.Crypto | Scope.Scope
    >,
  ) => runtime.runPromise(effect.pipe(Effect.scoped, Effect.timeout("50 seconds")))

  const dataDir = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    return `${yield* fs.makeTempDirectoryScoped({ prefix: "akter-embedded-" })}/data`
  })

  const spawn = (mode: string, directory: string, env: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      return yield* spawner.spawn(
        ChildProcess.make("bun", [entry], {
          env: { PGLITE_MODE: mode, PGLITE_DATA_DIR: directory, ...env },
          extendEnv: true,
          stderr: "inherit",
        }),
      )
    })

  type Child = Effect.Success<ReturnType<typeof spawn>>

  /** Waits for `count` stdout lines starting with `prefix`. */
  const waitFor = (child: Child, prefix: string, count = 1) =>
    child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.startsWith(prefix)),
      Stream.take(count),
      Stream.runCollect,
      Effect.map((lines) => Array.from(lines)),
    )

  const kill = Effect.fnUntraced(function* (child: Child) {
    yield* child.kill({ killSignal: "SIGKILL" })
    expect(String((yield* child.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")
  })

  /** Runs `mode` to completion and returns the payload of its line starting with `prefix`. */
  const complete = Effect.fnUntraced(function* (
    mode: string,
    directory: string,
    prefix: string,
    env: Record<string, string> = {},
  ) {
    const child = yield* spawn(mode, directory, env)
    const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString)
    expect(yield* child.exitCode, output).toBe(0)
    const line = output.split("\n").find((candidate) => candidate.startsWith(`${prefix} `))
    expect(line, output).toBeDefined()

    return line!.slice(prefix.length + 1)
  })

  const json = (text: string) => Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text)

  const commandId = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis

    return `v1.${now}.${now + 60_000}.${yield* (yield* Crypto.Crypto).randomUUIDv4}`
  })

  it(
    "recovers the last committed turn after SIGKILL at beforeCommit and afterCommit, and replays its receipt",
    () =>
      run(
        Effect.gen(function* () {
          for (const point of ["beforeCommit", "afterCommit"] as const) {
            const directory = yield* dataDir
            const id = yield* commandId
            const child = yield* spawn(`turn:${point}`, directory, { PGLITE_COMMAND_ID: id })
            yield* waitFor(child, "READY")
            yield* kill(child)

            const result = yield* json(
              yield* complete("turn:recover", directory, "RESULT", { PGLITE_COMMAND_ID: id }),
            )

            expect(result).toEqual({
              runs: point === "beforeCommit" ? 1 : 0,
              value: 47,
              receipts: 1,
              events: 1,
              count: "47",
            })
          }
        }),
      ),
    60_000,
  )

  it(
    "recovers committed outbox rows and effects after SIGKILL and delivers each once",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const directory = yield* dataDir
          const calls = `${directory}.calls`
          yield* fs.writeFileString(calls, "")
          const child = yield* spawn("deliver:crash", directory, { PGLITE_CALLS: calls })

          expect((yield* waitFor(child, "READY", 2)).toSorted()).toEqual([
            "READY afterExecute",
            "READY beforeOutboxDelete",
          ])
          yield* kill(child)

          const delivered = yield* json(
            yield* complete("deliver:recover", directory, "DELIVERED", { PGLITE_CALLS: calls }),
          )

          expect(delivered).toEqual({ outbox: 0, receives: 1, charged: 1, runs: 0, payee: "3" })

          const keys = (yield* fs.readFileString(calls)).trim().split("\n")
          expect(keys.length).toBe(2)
          expect(new Set(keys).size).toBe(1)
        }),
      ),
    60_000,
  )

  it(
    "refuses a second process with DataDirLocked while the first runs, and admits a new process after the first is SIGKILLed",
    () =>
      run(
        Effect.gen(function* () {
          const directory = yield* dataDir
          const first = yield* spawn("open", directory)
          yield* waitFor(first, "OPEN")

          expect(yield* complete("open", directory, "REFUSED")).toBe(`DataDirLocked ${directory}`)

          yield* kill(first)
          const third = yield* spawn("open", directory)
          yield* waitFor(third, "OPEN")
          yield* kill(third)
        }),
      ),
    60_000,
  )

  it(
    "restores a stopped copy and refuses expired command ids after restore",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const directory = yield* dataDir
          const kept = yield* complete("deposit:4000", directory, "ID")

          const backup = `${directory}.backup`
          yield* fs.copy(directory, backup)
          const lost = yield* complete("deposit:4000", directory, "ID")

          yield* fs.remove(directory, { recursive: true })
          yield* fs.copy(backup, directory)

          const restored = yield* json(
            yield* complete("restored", directory, "RESULT", {
              PGLITE_COMMAND_ID: `${kept},${lost}`,
            }),
          )

          expect(restored).toEqual({
            runs: 0,
            outcomes: ["CommandExpired", "CommandExpired"],
            receipts: 1,
            events: 1,
            count: "1",
          })
        }),
      ),
    60_000,
  )

  it(
    "fails with DataDirVersion on a dataDir from another Postgres major",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const directory = yield* dataDir
          yield* fs.makeDirectory(directory, { recursive: true })
          yield* fs.writeFileString(`${directory}/PG_VERSION`, "17\n")

          const exit = yield* Layer.build(Database.pglite({ dataDir: directory })).pipe(Effect.exit)

          expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
            DataDirVersion.make({ dataDir: directory, found: "17", expected: POSTGRES_MAJOR }),
          )
          expect((yield* fs.readDirectory(directory)).toSorted()).toEqual([LOCK_FILE, "PG_VERSION"])
        }),
      ),
    60_000,
  )

  it(
    "refuses relaxedDurability with a dataDir",
    () =>
      run(
        Effect.gen(function* () {
          const directory = yield* dataDir

          const exit = yield* Layer.build(
            Database.pglite({ dataDir: directory, relaxedDurability: true }),
          ).pipe(Effect.exit)

          expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
            "A file-backed PGlite database refuses relaxedDurability",
          )

          yield* Layer.build(Database.pglite({ relaxedDurability: true }))
        }),
      ),
    60_000,
  )

  it(
    "refuses a second layer on an open dataDir in the same process, and pins the Postgres major the bundled PGlite writes",
    () =>
      run(
        Effect.gen(function* () {
          const directory = yield* dataDir
          yield* Layer.build(Database.pglite({ dataDir: directory }))

          const exit = yield* Layer.build(Database.pglite({ dataDir: directory })).pipe(Effect.exit)

          expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
            DataDirLocked.make({ dataDir: directory }),
          )
          const fs = yield* FileSystem.FileSystem
          expect((yield* fs.readFileString(`${directory}/PG_VERSION`)).trim()).toBe(POSTGRES_MAJOR)
        }),
      ),
    60_000,
  )
})
