import { BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, ManagedRuntime, Schema } from "effect"
import { Manifest, updateCatalogs } from "./catalogs.ts"

const args = process.argv.slice(2)

const path = args.find((x) => !x.startsWith("--")) ?? "package.json"

const RegistryVersions = Schema.Union([Schema.String, Schema.mutable(Schema.Array(Schema.String))])

const packageName = Schema.String.check(Schema.isPattern(/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i))

const registry = Effect.fn("registryVersions")(function* (name: string) {
  yield* Schema.decodeEffect(packageName)(name)

  const child = Bun.spawn(["npm", "view", name, "versions", "--json"], {
    stdout: "pipe",
    stderr: "inherit",
  })

  const text = yield* Effect.promise(() => new Response(child.stdout).text())

  if ((yield* Effect.promise(() => child.exited)) !== 0)
    return yield* Effect.die(new Error(`Registry metadata unavailable: ${name}`))
  const versions = yield* Schema.decodeEffect(Schema.fromJsonString(RegistryVersions))(text)

  return Array.isArray(versions) ? versions : [versions]
})

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  const original = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(
    yield* fs.readFileString(path),
  )

  const result = yield* updateCatalogs(original, registry)
  const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
  yield* Console.log(yield* encode(result.report))

  if (args.includes("--write")) {
    yield* fs.writeFileString(path, `${yield* encode(result.manifest)}\n`)

    const install = Bun.spawn(["bun", "install", "--ignore-scripts"], {
      stdout: "inherit",
      stderr: "inherit",
    })

    if ((yield* Effect.promise(() => install.exited)) !== 0)
      return yield* Effect.die(new Error("Updated manifest requires lockfile repair before review"))
  }
})

const runtime = ManagedRuntime.make(BunServices.layer)

try {
  await runtime.runPromise(program)
} finally {
  await runtime.dispose()
}
