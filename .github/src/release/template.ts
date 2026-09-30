import { BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, ManagedRuntime, Path, Schema } from "effect"
import { FrameworkManifest, pinTemplateManifest, TemplateManifest } from "./manifest.ts"

const Versions = Schema.Record(Schema.String, Schema.String)

const WorkspaceManifest = Schema.Struct({
  workspaces: Schema.optionalKey(Schema.Struct({ catalog: Schema.optionalKey(Versions) })),
  devDependencies: Schema.optionalKey(Versions),
})

/**
 * Builds `@durable-actors/create`: writes `dist/manifest.json`, the template
 * manifest with every dependency pinned, so the published scaffold carries its
 * versions and never reads this repository.
 */
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(import.meta.dirname, "../../..")
  const create = path.join(root, "packages/create")

  const workspace = yield* Schema.decodeEffect(Schema.fromJsonString(WorkspaceManifest))(
    yield* fs.readFileString(path.join(root, "package.json")),
  )

  const template = yield* Schema.decodeEffect(Schema.fromJsonString(TemplateManifest))(
    yield* fs.readFileString(path.join(create, "templates/manifest.json")),
  )

  const framework = yield* Schema.decodeEffect(Schema.fromJsonString(FrameworkManifest))(
    yield* fs.readFileString(path.join(root, "packages/durable-actors/package.json")),
  )

  const pinned = pinTemplateManifest({
    template,
    catalog: workspace.workspaces?.catalog ?? {},
    rootDevDependencies: workspace.devDependencies ?? {},
    framework,
  })

  const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
    pinned,
  )

  yield* fs.makeDirectory(path.join(create, "dist"), { recursive: true })
  yield* fs.writeFileString(path.join(create, "dist/manifest.json"), `${json}\n`)
  yield* Console.log(
    `packages/create/dist/manifest.json pins ${pinned.dependencies["@durable-actors/core"]}`,
  )
})

const runtime = ManagedRuntime.make(BunServices.layer)

try {
  await runtime.runPromise(program)
} finally {
  await runtime.dispose()
}
