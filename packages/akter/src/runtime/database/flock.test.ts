import { BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, ManagedRuntime, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { afterAll, describe, expect, it } from "vitest"
import { flockExclusive } from "./flock.ts"

const holder = new URL("./flock-holder.ts", import.meta.url).pathname

describe("flockExclusive", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  afterAll(() => runtime.dispose())

  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
    >,
  ) => runtime.runPromise(effect.pipe(Effect.scoped, Effect.timeout("25 seconds")))

  const lockPath = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    return `${yield* fs.makeTempDirectoryScoped({ prefix: "akter-flock-" })}/nested/data/.akter.lock`
  })

  const holdOnce = (path: string) => Effect.scoped(flockExclusive(path))

  it("refuses a second descriptor while the first scope is open, admits one after it closes, and locks different files independently", () =>
    run(
      Effect.gen(function* () {
        const path = yield* lockPath

        const open = yield* Effect.scoped(
          Effect.gen(function* () {
            return {
              first: yield* flockExclusive(path),
              second: yield* holdOnce(path),
              other: yield* flockExclusive(`${path}.other`),
            }
          }),
        )

        expect(open).toEqual({ first: true, second: false, other: true })
        expect(yield* holdOnce(path)).toBe(true)
      }),
    ))

  const holderOf = (runtimeCommand: string, path: string) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const child = yield* spawner.spawn(
        ChildProcess.make(runtimeCommand, [holder], {
          env: { FLOCK_PATH: path },
          extendEnv: true,
          stderr: "inherit",
        }),
      )

      const [line] = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(1),
        Stream.runCollect,
      )

      return { child, line }
    })

  it.each(["node", "bun"] as const)(
    "holds across processes under %s until the holder is SIGKILLed, then admits",
    (name) =>
      run(
        Effect.gen(function* () {
          const command =
            name === "bun"
              ? "bun"
              : yield* Config.String("AKTER_TEST_NODE").pipe(Config.withDefault("node"))

          const path = yield* lockPath
          const first = yield* holderOf(command, path)
          expect(first.line).toBe("HELD")

          expect(yield* holdOnce(path)).toBe(false)
          expect((yield* holderOf(command, path)).line).toBe("BUSY")

          yield* first.child.kill({ killSignal: "SIGKILL" })
          expect(String((yield* first.child.exitCode.pipe(Effect.flip)).cause)).toContain("SIGKILL")

          expect(yield* holdOnce(path)).toBe(true)
        }),
      ),
    30_000,
  )
})
