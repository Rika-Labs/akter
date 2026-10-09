import { BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, ManagedRuntime, Path, Schema } from "effect"
import { Manifest } from "./catalogs.ts"
import { canaryVersion, releaseVersion } from "./release/version.ts"
import {
  FrameworkManifest,
  publishManifest,
  tarballProblems,
  undeclaredImports,
} from "./release/manifest.ts"

const args = process.argv.slice(2)
const outIndex = args.indexOf("--out")
const cliOutIndex = args.indexOf("--cli-out")
const canaryIndex = args.indexOf("--canary")

const PackedPackage = Schema.Struct({ files: Schema.Array(Schema.Struct({ path: Schema.String })) })

/**
 * `npm pack --json` prints an array of packed packages through npm 11 and an object keyed by
 * package name from npm 12, which the release workflow installs; both shapes are accepted.
 */
const PackResult = Schema.fromJsonString(
  Schema.Union([Schema.Array(PackedPackage), Schema.Record(Schema.String, PackedPackage)]),
)

const run = Effect.fn("run")(function* (command: ReadonlyArray<string>, cwd: string) {
  const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "inherit" })
  const stdout = yield* Effect.promise(() => new Response(child.stdout).text())

  if ((yield* Effect.promise(() => child.exited)) !== 0)
    return yield* Effect.die(new Error(`${command.join(" ")} failed`))

  return stdout
})

const stagePackage = Effect.fn("stagePackage")(function* ({
  fs,
  path,
  root,
  source,
  stage,
  catalog,
  versions,
  version,
}: {
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly root: string
  readonly source: string
  readonly stage: string
  readonly catalog: Readonly<Record<string, string>>
  readonly versions: Readonly<Record<string, string>>
  readonly version: string
}) {
  yield* fs.remove(path.join(source, "dist"), { recursive: true, force: true })
  yield* run(["bun", "run", "build"], source)

  const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(FrameworkManifest))(
    yield* fs.readFileString(path.join(source, "package.json")),
  )
  const packed = publishManifest({
    manifest: { ...manifest, version },
    catalog,
    workspaceVersions: versions,
  })

  yield* fs.remove(stage, { recursive: true, force: true })
  yield* fs.makeDirectory(stage, { recursive: true })
  yield* fs.copy(path.join(source, "dist"), path.join(stage, "dist"))

  for (const file of ["README.md", "CHANGELOG.md"])
    yield* fs.copyFile(path.join(source, file), path.join(stage, file))

  for (const file of ["LICENSE", "NOTICE"])
    yield* fs.copyFile(path.join(root, file), path.join(stage, file))

  const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(packed)
  yield* fs.writeFileString(path.join(stage, "package.json"), `${json}\n`)

  const packResult = yield* Schema.decodeEffect(PackResult)(
    yield* run(["npm", "pack", "--dry-run", "--json", "--ignore-scripts", stage], root),
  )
  const packedPackages: ReadonlyArray<typeof PackedPackage.Type> = Array.isArray(packResult)
    ? packResult
    : Object.values(packResult)
  const [result] = packedPackages
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
    return yield* Effect.die(
      new Error(`${packed.name} tarball is not publishable:\n${problems.join("\n")}`),
    )

  yield* Console.log(
    `${packed.name}@${packed.version}: ${files.length} files pass the tarball check; staged at ${stage}`,
  )
})

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(import.meta.dirname, "../..")
  const framework = path.join(root, "packages/akter")
  const cli = path.join(root, "apps/cli")
  const work = yield* fs.makeTempDirectoryScoped({ prefix: "akter-pack-" })
  const out = args[outIndex + 1]
  const cliOut = args[cliOutIndex + 1]
  const canary = args[canaryIndex + 1]

  if (outIndex !== -1 && (out === undefined || out === "" || out.startsWith("--")))
    return yield* Effect.die(new Error("--out needs a directory"))
  if (cliOutIndex !== -1 && (cliOut === undefined || cliOut === "" || cliOut.startsWith("--")))
    return yield* Effect.die(new Error("--cli-out needs a directory"))
  if (canaryIndex !== -1 && (canary === undefined || canary === "" || canary.startsWith("--")))
    return yield* Effect.die(new Error("--canary needs a build identity"))

  const frameworkStage =
    out === undefined || outIndex === -1 ? path.join(work, "framework") : path.resolve(out)
  const cliStage =
    cliOut === undefined || cliOutIndex === -1
      ? out === undefined || outIndex === -1
        ? path.join(work, "cli")
        : path.join(path.dirname(frameworkStage), `${path.basename(frameworkStage)}-cli`)
      : path.resolve(cliOut)

  for (const stage of [frameworkStage, cliStage]) {
    const relative = path.relative(stage, root)
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
      return yield* Effect.die(new Error(`--out ${stage} would replace the repository`))
    const inRepository = path.relative(root, stage)
    const scratch = path.relative(path.join(root, ".local"), stage)
    if (
      !inRepository.startsWith("..") &&
      !path.isAbsolute(inRepository) &&
      (scratch === "" || scratch.startsWith("..") || path.isAbsolute(scratch))
    )
      return yield* Effect.die(new Error(`--out ${stage} is inside the repository; use .local/`))
  }

  const relativeStages = path.relative(frameworkStage, cliStage)
  const reverseStages = path.relative(cliStage, frameworkStage)
  if (
    relativeStages === "" ||
    (!relativeStages.startsWith("..") && !path.isAbsolute(relativeStages)) ||
    (!reverseStages.startsWith("..") && !path.isAbsolute(reverseStages))
  )
    return yield* Effect.die(
      new Error("The framework and CLI staging directories must not overlap"),
    )

  const workspace = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(
    yield* fs.readFileString(path.join(root, "package.json")),
  )
  const decode = Schema.decodeEffect(Schema.fromJsonString(FrameworkManifest))
  const frameworkManifest = yield* decode(
    yield* fs.readFileString(path.join(framework, "package.json")),
  )
  const cliManifest = yield* decode(yield* fs.readFileString(path.join(cli, "package.json")))
  const released = releaseVersion({
    framework: frameworkManifest.version,
    cli: cliManifest.version,
  })
  const version =
    canaryIndex === -1 ? released : canaryVersion({ version: released, build: canary ?? "" })
  const versions = { [frameworkManifest.name]: version }
  const catalog = workspace.workspaces?.catalog ?? {}

  yield* stagePackage({
    fs,
    path,
    root,
    source: framework,
    stage: frameworkStage,
    catalog,
    versions,
    version,
  })
  yield* stagePackage({ fs, path, root, source: cli, stage: cliStage, catalog, versions, version })
}).pipe(Effect.scoped)

const runtime = ManagedRuntime.make(BunServices.layer)

try {
  await runtime.runPromise(program)
} finally {
  await runtime.dispose()
}
