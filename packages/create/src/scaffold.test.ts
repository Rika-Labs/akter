import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime, Path, Schema, Scope } from "effect"
import { afterAll, expect, it } from "vitest"
import rootManifest from "../../../package.json" with { type: "json" }
import coreManifest from "../../durable-actors/package.json" with { type: "json" }
import {
  manifest,
  packageName,
  parseArguments,
  scaffold,
  TargetNotEmpty,
  templates,
  UnknownTemplate,
  UsageError,
  versions,
} from "./scaffold.ts"

const runtime = ManagedRuntime.make(BunServices.layer)

afterAll(() => runtime.dispose())

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  runtime.runPromise(Effect.scoped(effect))

it("pins the versions the core package is built and released against", () => {
  const catalog: Readonly<Record<string, string>> = rootManifest.workspaces.catalog

  expect(versions["@durable-actors/core"]).toBe(coreManifest.version)
  expect(versions["@types/bun"]).toBe(rootManifest.devDependencies["@types/bun"])

  for (const name of Object.keys(coreManifest.peerDependencies))
    expect(manifest("app").dependencies).toHaveProperty(name)

  for (const name of [
    "effect",
    "@effect/platform-bun",
    "@effect/sql-pg",
    "@effect/sql-pglite",
    "drizzle-orm",
    "typescript",
  ] as const)
    expect(versions[name]).toBe(catalog[name])

  expect(manifest("app").overrides).toEqual({ "@effect/platform-node-shared": catalog.effect })
})

it("derives an installable package name from the directory", () => {
  expect(packageName("My App")).toBe("my-app")
  expect(packageName(".hidden")).toBe("hidden")
  expect(packageName("???")).toBe("durable-actors-app")
})

it("reads the directory and template in either order and rejects anything else", () =>
  run(
    Effect.gen(function* () {
      expect(yield* parseArguments([])).toEqual({
        help: false,
        template: "counter",
        directory: "durable-actors-app",
      })
      expect(yield* parseArguments(["--template", "chat", "app"])).toEqual({
        help: false,
        template: "chat",
        directory: "app",
      })
      expect(yield* parseArguments(["app", "--template=chat"])).toMatchObject({ template: "chat" })
      expect(yield* parseArguments(["--help"])).toEqual({ help: true })

      expect(yield* parseArguments(["app", "--templat", "chat"]).pipe(Effect.flip)).toBeInstanceOf(
        UsageError,
      )
      expect(yield* parseArguments(["app", "extra"]).pipe(Effect.flip)).toBeInstanceOf(UsageError)
      expect(yield* parseArguments(["--template"]).pipe(Effect.flip)).toBeInstanceOf(UsageError)
      expect(yield* parseArguments(["--template", "todo"]).pipe(Effect.flip)).toBeInstanceOf(
        UnknownTemplate,
      )
    }),
  ))

it.each(templates)("scaffolds the %s template into a fresh directory", (template) =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const work = yield* fs.makeTempDirectoryScoped({ prefix: "create-" })
      const target = yield* scaffold(template, path.join(work, "My App"))

      const files = yield* fs.readDirectory(target, { recursive: true })

      expect(files).toEqual(
        expect.arrayContaining([".gitignore", "package.json", "tsconfig.json", "src/main.ts"]),
      )
      expect(files).not.toContain("gitignore")

      const written = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        yield* fs.readFileString(path.join(target, "package.json")),
      )

      expect(written).toEqual(manifest("my-app"))
    }),
  ),
)

it("refuses a directory that already has files", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const work = yield* fs.makeTempDirectoryScoped({ prefix: "create-" })
      yield* fs.writeFileString(path.join(work, "keep.txt"), "mine")

      const failure = yield* scaffold("counter", work).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(TargetNotEmpty)
      expect(yield* fs.readDirectory(work)).toEqual(["keep.txt"])
    }),
  ))
