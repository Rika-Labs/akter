import { BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, ManagedRuntime, Schema } from "effect"

/** The CLI and framework form one immutable npm release unit. */
export function releaseVersion({
  framework,
  cli,
}: {
  readonly framework: string
  readonly cli: string
}) {
  if (framework !== cli)
    throw new Error(`CLI version ${cli} does not match framework version ${framework}`)
  return framework
}

/** Tagged prereleases retain their channel; before 1.0 they are also the default install. */
export function releaseTags(version: string) {
  const core = version.split("+")[0] ?? ""
  const prerelease = core.indexOf("-")
  const tag = prerelease === -1 ? "latest" : core.slice(prerelease + 1).split(".")[0]
  if (tag === undefined || !/^[a-z][a-z0-9-]*$/.test(tag))
    throw new Error(`Prerelease id of ${version} is not a dist-tag name`)
  return { tag, latest: core.startsWith("0.") && tag !== "latest" && tag !== "next" }
}

/** Run identity stays in the prerelease, since npm does not distinguish build metadata. */
export function canaryVersion({
  version,
  build,
}: {
  readonly version: string
  readonly build: string
}) {
  if (!/^[1-9]\d*\.[1-9]\d*\.g[0-9a-f]{12}$/.test(build))
    throw new Error("Canary build must be <run-id>.<attempt>.g<12-character-sha>")
  return `${version.split(/[-+]/)[0]}-next.${build}`
}

if (import.meta.main) {
  const runtime = ManagedRuntime.make(BunServices.layer)
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const decode = Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
        )
        const framework = yield* decode(yield* fs.readFileString("packages/akter/package.json"))
        const cli = yield* decode(yield* fs.readFileString("apps/cli/package.json"))
        const version = releaseVersion({ framework: framework.version, cli: cli.version })
        const tags = releaseTags(version)
        yield* Console.log(`tag=${tags.tag}\npromote_latest=${tags.latest}`)
      }),
    )
  } finally {
    await runtime.dispose()
  }
}
