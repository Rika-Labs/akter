import { BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, ManagedRuntime, Path, Schema } from "effect"
import { Manifest } from "./catalogs.ts"
import { FrameworkManifest, publishManifest, tarballProblems } from "./release.ts"

const args = process.argv.slice(2)

const outIndex = args.indexOf("--out")

const PackResult = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ files: Schema.Array(Schema.Struct({ path: Schema.String })) })),
)

const run = Effect.fn("run")(function* (command: ReadonlyArray<string>, cwd: string) {
  const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "inherit" })
  const stdout = yield* Effect.promise(() => new Response(child.stdout).text())

  if ((yield* Effect.promise(() => child.exited)) !== 0)
    return yield* Effect.die(new Error(`${command.join(" ")} failed`))

  return stdout
})

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(import.meta.dirname, "../..")
  const framework = path.join(root, "packages/durable-actors")

  const stage =
    outIndex === -1
      ? yield* fs.makeTempDirectoryScoped({ prefix: "durable-actors-pack-" })
      : path.resolve(args[outIndex + 1] ?? "")

  yield* fs.remove(path.join(framework, "dist"), { recursive: true, force: true })
  yield* run(["bun", "run", "build"], framework)

  const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(FrameworkManifest))(
    yield* fs.readFileString(path.join(framework, "package.json")),
  )

  const workspace = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(
    yield* fs.readFileString(path.join(root, "package.json")),
  )

  const packed = publishManifest({ manifest, catalog: workspace.workspaces?.catalog ?? {} })

  yield* fs.remove(stage, { recursive: true, force: true })
  yield* fs.makeDirectory(stage, { recursive: true })
  yield* fs.copy(path.join(framework, "dist"), path.join(stage, "dist"))

  for (const file of ["README.md", "CHANGELOG.md"])
    yield* fs.copyFile(path.join(framework, file), path.join(stage, file))

  for (const file of ["LICENSE", "NOTICE"])
    yield* fs.copyFile(path.join(root, file), path.join(stage, file))

  const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(packed)
  yield* fs.writeFileString(path.join(stage, "package.json"), `${json}\n`)

  const [result] = yield* Schema.decodeEffect(PackResult)(
    yield* run(["npm", "pack", "--dry-run", "--json", "--ignore-scripts", stage], root),
  )

  const files = (result?.files ?? []).map((file) => file.path)
  const problems = tarballProblems({ files, manifest: packed })

  if (problems.length > 0)
    return yield* Effect.die(new Error(`Tarball is not publishable:\n${problems.join("\n")}`))

  yield* Console.log(
    `${packed.name}@${packed.version}: ${files.length} files pass the tarball check${outIndex === -1 ? "" : `; staged at ${stage}`}`,
  )
}).pipe(Effect.scoped)

const runtime = ManagedRuntime.make(BunServices.layer)

try {
  await runtime.runPromise(program)
} finally {
  await runtime.dispose()
}
