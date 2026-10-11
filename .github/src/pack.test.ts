import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime, Path } from "effect"
import { afterAll, expect, it } from "vitest"

const runtime = ManagedRuntime.make(BunServices.layer)
afterAll(() => runtime.dispose())

it.each(["bun", "node"] as const)(
  "bundles a server without cold storage or AWS/Smithy modules for %s",
  (target) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const work = yield* fs.makeTempDirectoryScoped({ prefix: "akter-server-bundle-" })
        yield* fs.makeDirectory(path.join(work, "node_modules/@rikalabs"), { recursive: true })
        yield* fs.symlink(
          path.resolve(import.meta.dirname, "../../packages/akter"),
          path.join(work, "node_modules/@rikalabs/akter"),
        )
        yield* fs.symlink(
          path.resolve(import.meta.dirname, "../../node_modules/effect"),
          path.join(work, "node_modules/effect"),
        )
        const entrypoint = path.join(work, "server.ts")
        yield* fs.writeFileString(
          entrypoint,
          `import { Actor } from "@rikalabs/akter"
import { Actors } from "@rikalabs/akter/runtime"
import { Schema } from "effect"
export const Counter = Actor.make("Counter", { key: Schema.String, api: {} })
export const Server = Actors.layer()
`,
        )
        const build = yield* Effect.promise(() =>
          Bun.build({
            entrypoints: [entrypoint],
            target,
            splitting: false,
            sourcemap: "external",
            metafile: true,
            external: ["koffi", "@node-rs/xxhash"],
          }),
        )
        expect(build.success).toBe(true)
        expect(build.metafile).toBeDefined()
        const sources = Object.keys(build.metafile!.inputs)
        expect(sources.some((source) => source.endsWith("runtime/actors.ts"))).toBe(true)
        expect(sources.filter((source) => /@(?:aws-sdk|smithy)\//.test(source))).toEqual([])
      }).pipe(Effect.scoped),
    ),
)
