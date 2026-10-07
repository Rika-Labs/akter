import { expect, it } from "vitest"
import { releaseVersion } from "./version.ts"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime } from "effect"

it("accepts a matching release unit and rejects a different CLI alpha before publication", () => {
  expect(releaseVersion({ framework: "0.1.0-alpha.7", cli: "0.1.0-alpha.7" })).toBe("0.1.0-alpha.7")
  expect(() => releaseVersion({ framework: "0.1.0-alpha.7", cli: "0.1.0-alpha.8" })).toThrow(
    "CLI version 0.1.0-alpha.8 does not match framework version 0.1.0-alpha.7",
  )
  expect(() => releaseVersion({ framework: "1.0.0", cli: "1.0.0+different-build" })).toThrow(
    "does not match",
  )
})

it("runs the manifest gate before publishing and refuses a mismatched package on disk", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)
  return runtime
    .runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akter-release-version-" })
        yield* fs.makeDirectory(`${directory}/packages/akter`, { recursive: true })
        yield* fs.makeDirectory(`${directory}/apps/cli`, { recursive: true })
        yield* fs.writeFileString(
          `${directory}/packages/akter/package.json`,
          '{"version":"0.1.0-alpha.7"}',
        )
        yield* fs.writeFileString(
          `${directory}/apps/cli/package.json`,
          '{"version":"0.1.0-alpha.8"}',
        )
        const child = Bun.spawn(["bun", new URL("./version.ts", import.meta.url).pathname], {
          cwd: directory,
          stdout: "pipe",
          stderr: "pipe",
        })
        const stderr = yield* Effect.promise(() => new Response(child.stderr).text())
        expect(yield* Effect.promise(() => child.exited)).not.toBe(0)
        expect(stderr).toContain(
          "CLI version 0.1.0-alpha.8 does not match framework version 0.1.0-alpha.7",
        )
        const workflow = yield* fs.readFileString(
          new URL("../../workflows/release.yml", import.meta.url).pathname,
        )
        const gate = workflow.indexOf("bun .github/src/release/version.ts")
        expect(gate).toBeGreaterThan(-1)
        expect(gate).toBeLessThan(workflow.indexOf("npm publish"))
      }).pipe(Effect.scoped),
    )
    .finally(() => runtime.dispose())
})
