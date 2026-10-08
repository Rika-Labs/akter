import { expect, it } from "vitest"
import { canaryVersion, releaseTags, releaseVersion } from "./version.ts"
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

it("promotes pre-1.0 channels but never next canaries or post-1.0 prereleases", () => {
  expect(releaseTags("0.1.0-alpha.2+build.7")).toEqual({ tag: "alpha", latest: true })
  expect(releaseTags("0.9.7-rc.12")).toEqual({ tag: "rc", latest: true })
  expect(releaseTags("0.9.7")).toEqual({ tag: "latest", latest: false })
  expect(releaseTags("1.0.0-alpha.1")).toEqual({ tag: "alpha", latest: false })
  expect(releaseTags("1.0.0")).toEqual({ tag: "latest", latest: false })
  expect(releaseTags("0.1.0-next.321.1.g123456abcdef")).toEqual({ tag: "next", latest: false })
  expect(() => releaseTags("0.1.0-123.1")).toThrow("dist-tag name")
})

it("gives canary runs and reruns distinct npm versions without retaining alpha or build metadata", () => {
  expect(canaryVersion({ version: "0.1.0-alpha.2+build.7", build: "321.1.g123456abcdef" })).toBe(
    "0.1.0-next.321.1.g123456abcdef",
  )
  expect(canaryVersion({ version: "0.1.0-alpha.2", build: "321.2.g123456abcdef" })).toBe(
    "0.1.0-next.321.2.g123456abcdef",
  )
  expect(canaryVersion({ version: "1.2.3", build: "654.1.gfedcba654321" })).toBe(
    "1.2.3-next.654.1.gfedcba654321",
  )
  for (const build of ["", "321.0.g123456abcdef", "321.1.g123456", "321.1.g123456ABCDEF"])
    expect(() => canaryVersion({ version: "0.1.0-alpha.2", build })).toThrow("Canary build")
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
        yield* fs.writeFileString(
          `${directory}/apps/cli/package.json`,
          '{"version":"0.1.0-alpha.7"}',
        )
        const matching = Bun.spawn(["bun", new URL("./version.ts", import.meta.url).pathname], {
          cwd: directory,
          stdout: "pipe",
          stderr: "pipe",
        })
        const output = yield* Effect.promise(() => new Response(matching.stdout).text())
        expect(yield* Effect.promise(() => matching.exited)).toBe(0)
        expect(output).toBe("tag=alpha\npromote_latest=true\n")
        const workflow = yield* fs.readFileString(
          new URL("../../workflows/release.yml", import.meta.url).pathname,
        )
        const gate = workflow.indexOf("bun .github/src/release/version.ts")
        expect(gate).toBeGreaterThan(-1)
        expect(gate).toBeLessThan(workflow.indexOf("npm publish"))
        expect(workflow).toContain("github.event.workflow_run.head_sha == github.sha")
        const identity = /test "\$commit" = "\$GITHUB_SHA" \|\| \{[^\n]+\}/.exec(workflow)?.[0]
        expect(identity).toBeDefined()
        if (identity === undefined) throw new Error("Provenance SHA gate is missing")
        for (const [sha, status] of [
          ["verified", 0],
          ["unverified", 1],
        ] as const)
          expect(
            Bun.spawnSync(["env", "commit=verified", `GITHUB_SHA=${sha}`, "bash", "-c", identity])
              .exitCode,
          ).toBe(status)
        const promotion = /bun -e '([^']+)' "\$version" "\$current"/.exec(workflow)?.[1]
        expect(promotion).toBeDefined()
        if (promotion === undefined) throw new Error("Latest promotion predicate is missing")
        for (const [candidate, current, status] of [
          ["0.1.0-alpha.2", "0.1.0-alpha.1", 0],
          ["0.1.0-alpha.2", "0.1.0-alpha.2", 0],
          ["0.1.0-alpha.2", "0.1.0-alpha.10", 1],
          ["0.1.0-alpha.2", "0.1.0", 1],
        ] as const)
          expect(Bun.spawnSync(["bun", "-e", promotion, candidate, current]).exitCode).toBe(status)
      }).pipe(Effect.scoped),
    )
    .finally(() => runtime.dispose())
})
