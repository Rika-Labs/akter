import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { runtimeBuild } from "./build.ts"

describe("runtimeBuild", () => {
  it.effect(
    "names the runtime and engine the process runs on (rejects taking the Node and V8 versions Bun emulates)",
    () =>
      Effect.gen(function* () {
        const build = yield* runtimeBuild({ bundle: "sha256:app", framework: "0.2.0-next.1" })
        expect(build).toMatchObject({ bundle: "sha256:app", framework: "0.2.0-next.1" })
        expect(build.platform).toBe(process.platform)
        expect(build.arch).toBe(process.arch)
        expect(build.icu).not.toBe("")
        expect(build.unicode).not.toBe("")
        const bun = globalThis.Bun?.version
        if (bun === undefined) {
          expect(build).toMatchObject({
            runtime: "node",
            runtimeVersion: process.version.slice(1),
            engine: "V8",
            engineVersion: process.versions.v8,
          })
          expect(build.tz).not.toBe("")
          return
        }
        expect(build).toMatchObject({
          runtime: "bun",
          runtimeVersion: bun,
          engine: "JavaScriptCore",
        })
        expect(build.engineVersion).not.toBe("")
        expect(build.engineVersion).not.toBe(process.versions.v8)
        expect(build.tz).toBe("")
      }),
  )
})
