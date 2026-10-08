import { Config, Effect, FileSystem, Layer, ManagedRuntime, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { afterAll, describe, expect, it } from "vitest"
import { DataDirLocked } from "../../../../../packages/akter/src/errors/database.ts"
import {
  LOCK_FILE,
  pglite,
  POSTGRES_MAJOR,
} from "../../../../../packages/akter/src/runtime/database/pglite.ts"

const fixture = new URL("./pglite-node.ts", import.meta.url).pathname

const services =
  process.versions.bun === undefined
    ? (await import("@effect/platform-node")).NodeServices.layer
    : (await import("@effect/platform-bun")).BunServices.layer

describe("file-backed PGlite under Node", () => {
  const runtime = ManagedRuntime.make(services)
  afterAll(() => runtime.dispose())

  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
    >,
  ) => runtime.runPromise(effect.pipe(Effect.scoped, Effect.timeout("50 seconds")))

  const dataDir = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    return `${yield* fs.makeTempDirectoryScoped({ prefix: "akter-pglite-node-" })}/data`
  })

  const spawn = (mode: string, directory: string, env: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const node = yield* Config.String("AKTER_TEST_NODE").pipe(Config.withDefault("node"))

      return yield* spawner.spawn(
        ChildProcess.make(node, [fixture], {
          env: { PGLITE_MODE: mode, PGLITE_DATA_DIR: directory, ...env },
          extendEnv: true,
          stderr: "inherit",
        }),
      )
    })

  /** Runs the fixture to completion and returns its stdout lines. */
  const finish = Effect.fnUntraced(function* (
    mode: string,
    directory: string,
    env: Record<string, string> = {},
  ) {
    const child = yield* spawn(mode, directory, env)
    const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString)
    expect(yield* child.exitCode, output).toBe(0)

    return output.trim().split("\n")
  })

  it(
    "persists committed rows across process restarts",
    () =>
      run(
        Effect.gen(function* () {
          const directory = yield* dataDir

          expect(yield* finish("write:b", directory)).toEqual(["RUNTIME node", "WROTE", "ROWS b"])
          expect(yield* finish("write:a", directory)).toEqual(["RUNTIME node", "WROTE", "ROWS a,b"])
          expect(yield* finish("read", directory)).toEqual(["RUNTIME node", "ROWS a,b"])
        }),
      ),
    60_000,
  )

  it(
    "refuses a second process while the first holds the directory, then admits one after SIGKILL with the committed row intact",
    () =>
      run(
        Effect.gen(function* () {
          const directory = yield* dataDir
          const first = yield* spawn("hold:kept", directory)

          const lines = yield* first.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.take(2),
            Stream.runCollect,
          )

          expect(Array.from(lines)).toEqual(["RUNTIME node", "WROTE"])

          expect(yield* finish("open", directory)).toEqual([
            "RUNTIME node",
            `REFUSED DataDirLocked ${directory}`,
          ])

          yield* first.kill({ killSignal: "SIGKILL" })
          expect(String((yield* first.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")

          expect(yield* finish("write:later", directory)).toEqual([
            "RUNTIME node",
            "WROTE",
            "ROWS kept,later",
          ])
        }),
      ),
    60_000,
  )

  it(
    "refuses a directory another Postgres major wrote before it opens PGlite",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const directory = yield* dataDir
          yield* finish("write:seed", directory)
          yield* fs.writeFileString(`${directory}/PG_VERSION`, "17\n")
          const before = yield* fs.readDirectory(directory)

          expect(yield* finish("read", directory)).toEqual([
            "RUNTIME node",
            `REFUSED DataDirVersion 17 ${POSTGRES_MAJOR}`,
          ])
          expect(yield* fs.readDirectory(directory)).toEqual(before)
          expect(before).toContain(LOCK_FILE)
        }),
      ),
    60_000,
  )

  it(
    "refuses relaxedDurability for a data directory before it creates anything",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const directory = yield* dataDir

          expect(yield* finish("open", directory, { PGLITE_RELAXED: "true" })).toEqual([
            "RUNTIME node",
            "REFUSED Defect Error: A file-backed PGlite database refuses relaxedDurability",
          ])
          expect(yield* fs.exists(directory)).toBe(false)
        }),
      ),
    60_000,
  )

  it(
    "refuses a second layer on an open directory in the same process",
    () =>
      run(
        Effect.gen(function* () {
          const directory = yield* dataDir
          yield* Layer.build(pglite({ dataDir: directory }))

          const refused = yield* Layer.build(pglite({ dataDir: directory })).pipe(
            Effect.scoped,
            Effect.flip,
          )

          expect(refused).toBeInstanceOf(DataDirLocked)
          expect(refused).toMatchObject({ dataDir: directory })
        }),
      ),
    60_000,
  )
})
