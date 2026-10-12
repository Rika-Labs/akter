import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime, Path } from "effect"
import { afterAll, expect, it } from "vitest"

const runtime = ManagedRuntime.make(BunServices.layer)
afterAll(() => runtime.dispose())

const AWS = /@(?:aws-sdk|smithy)\//

/** The source files a Bun build of `source`, importing the framework as a consumer would, reads. */
const bundledSources = (source: string, target: "bun" | "node") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const work = yield* fs.makeTempDirectoryScoped({ prefix: "akter-bundle-" })
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
    yield* fs.writeFileString(entrypoint, source)
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
    return Object.keys(build.metafile!.inputs)
  }).pipe(Effect.scoped)

it.each(["bun", "node"] as const)(
  "bundles the root entry without AWS/Smithy or engine modules for %s",
  (target) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sources = yield* bundledSources(
          `import { Actor, ActorError, User } from "@rikalabs/akter"
export const actor = Actor.make
export const caller = User.make({ subject: "bundle" })
export const failure = ActorError
`,
          target,
        )
        expect(sources.some((source) => source.endsWith("contract/errors.ts"))).toBe(true)
        expect(sources.filter((source) => AWS.test(source))).toEqual([])
        expect(
          sources.filter((source) =>
            /packages\/akter\/src\/(?:execution|snapshots|store|testing)\//.test(source),
          ),
        ).toEqual([])
      }),
    ),
)

it.each(["bun", "node"] as const)(
  "bundles a server that composes only Store.fileSystem and Store.memory without AWS/Smithy modules for %s, and Store.s3 with them",
  (target) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const local = yield* bundledSources(
          `import { Store } from "@rikalabs/akter/server"
export const stores = [Store.fileSystem("/srv/store"), Store.memory()]
`,
          target,
        )
        expect(local.some((source) => source.endsWith("store/file-system.ts"))).toBe(true)
        expect(local.filter((source) => AWS.test(source))).toEqual([])

        const remote = yield* bundledSources(
          `import { Store } from "@rikalabs/akter/server"
export const store = Store.s3({ bucket: "store" })
`,
          target,
        )
        expect(remote.some((source) => source.includes("@aws-sdk/client-s3/"))).toBe(true)
      }),
    ),
)

it.each(["bun", "node"] as const)(
  "bundles the client entry without server, engine, store or AWS/Smithy modules for %s",
  (target) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sources = yield* bundledSources(
          `import { AkterClient } from "@rikalabs/akter/client"
export const layer = AkterClient.layer
`,
          target,
        )
        expect(sources.some((source) => source.endsWith("client/transport.ts"))).toBe(true)
        expect(sources.some((source) => source.endsWith("rpc/group.ts"))).toBe(true)
        expect(sources.filter((source) => AWS.test(source))).toEqual([])
        expect(sources.filter((source) => source.includes("@effect/platform-"))).toEqual([])
        expect(
          sources.filter((source) =>
            /packages\/akter\/src\/(?:serve|store|snapshots|testing|runtime)\/|packages\/akter\/src\/server\.ts/.test(
              source,
            ),
          ),
        ).toEqual([])
        expect(
          sources
            .filter((source) => source.includes("packages/akter/src/execution/"))
            .map((source) => source.split("/").at(-1) ?? source)
            .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(["command-ids.ts", "digest.ts"])
      }),
    ),
)
