import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime, Path } from "effect"
import { afterAll, expect, it } from "vitest"

const runtime = ManagedRuntime.make(BunServices.layer)
afterAll(() => runtime.dispose())

it.each(["bun", "node"] as const)(
  "bundles the root entry without AWS/Smithy modules for %s",
  (target) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const work = yield* fs.makeTempDirectoryScoped({ prefix: "akter-root-bundle-" })
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
          `import { ActorError, ASSERTION_HEADER, User } from "@rikalabs/akter"
export const header = ASSERTION_HEADER
export const caller = User.make({ subject: "bundle" })
export const failure = ActorError
`,
        )
        const build = yield* Effect.promise(() =>
          Bun.build({
            entrypoints: [entrypoint],
            target,
            splitting: false,
            sourcemap: "external",
            metafile: true,
          }),
        )
        expect(build.success).toBe(true)
        expect(build.metafile).toBeDefined()
        const sources = Object.keys(build.metafile!.inputs)
        expect(sources.some((source) => source.endsWith("errors/actor.ts"))).toBe(true)
        expect(sources.filter((source) => /@(?:aws-sdk|smithy)\//.test(source))).toEqual([])
      }).pipe(Effect.scoped),
    ),
)
