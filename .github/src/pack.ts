import { BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, ManagedRuntime, Path, Schema } from "effect"
import { Manifest } from "./catalogs.ts"
import {
  FrameworkManifest,
  publishManifest,
  tarballProblems,
  undeclaredImports,
} from "./release/manifest.ts"

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
  const framework = path.join(root, "packages/akter")

  const out = args[outIndex + 1]

  if (outIndex !== -1 && (out === undefined || out === "" || out.startsWith("--")))
    return yield* Effect.die(new Error("--out needs a directory"))

  const stage =
    out === undefined || outIndex === -1
      ? yield* fs.makeTempDirectoryScoped({ prefix: "akter-pack-" })
      : path.resolve(out)

  if (path.relative(stage, root) === "" || !path.relative(stage, root).startsWith(".."))
    return yield* Effect.die(new Error(`--out ${stage} would replace the repository`))

  const inRepository = path.relative(root, stage)
  const scratch = path.relative(path.join(root, ".local"), stage)

  if (
    !inRepository.startsWith("..") &&
    !path.isAbsolute(inRepository) &&
    (scratch === "" || scratch.startsWith("..") || path.isAbsolute(scratch))
  )
    return yield* Effect.die(
      new Error(`--out ${stage} is inside the repository; use a directory under .local/`),
    )

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

  const sources = yield* Effect.forEach(
    files.filter((file) => file.endsWith(".js")),
    (file) => fs.readFileString(path.join(stage, file)),
  )

  const problems = [
    ...tarballProblems({ files, manifest: packed }),
    ...undeclaredImports({ sources, manifest: packed }).map(
      (name) => `imports undeclared package ${name}`,
    ),
  ]

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
