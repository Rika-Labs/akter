import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime, Path, Schema, Scope } from "effect"
import { afterAll, expect, it } from "vitest"
import {
  packageName,
  parseArguments,
  scaffold,
  TargetNotEmpty,
  templates,
  UnknownTemplate,
  UsageError,
} from "./scaffold.ts"

const runtime = ManagedRuntime.make(BunServices.layer)

afterAll(() => runtime.dispose())

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  runtime.runPromise(Effect.scoped(effect))

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

const ownFiles = { counter: "src/counter/contract.ts", chat: "src/room/contract.ts" } as const

const exactVersion = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

it.each(templates)("scaffolds the %s template from the shared base and its own files", (template) =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const work = yield* fs.makeTempDirectoryScoped({ prefix: "create-" })
      const target = yield* scaffold(template, path.join(work, "My App"))

      const files = yield* fs.readDirectory(target, { recursive: true })

      expect(files).toEqual(
        expect.arrayContaining([
          ".gitignore",
          "package.json",
          "tsconfig.json",
          "src/database.ts",
          "src/main.ts",
          ownFiles[template],
        ]),
      )
      expect(files).not.toContain("gitignore")
      expect(files).not.toContain(ownFiles[template === "counter" ? "chat" : "counter"])

      const written = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            name: Schema.String,
            dependencies: Schema.Record(Schema.String, Schema.String),
            devDependencies: Schema.Record(Schema.String, Schema.String),
          }),
        ),
      )(yield* fs.readFileString(path.join(target, "package.json")))

      expect(written.name).toBe("my-app")
      expect(Object.keys(written.dependencies)).toContain("@durable-actors/core")
      expect(
        Object.entries({ ...written.dependencies, ...written.devDependencies }).filter(
          ([, version]) => !exactVersion.test(version),
        ),
      ).toEqual([])
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
