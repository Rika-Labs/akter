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
  return {
    tag,
    latest: core.startsWith("0.") && tag !== "latest" && !canaryChannelNames.includes(tag),
  }
}

/** Each branch that publishes canaries owns one dist-tag, and neither is `latest`. */
const canaryChannels = new Map([
  ["main", "next"],
  ["rewrite/0.2", "rewrite"],
])

const canaryChannelNames = [...canaryChannels.values()]

/** The dist-tag a verified push to `branch` publishes under; any other branch is refused. */
export function canaryChannel(branch: string) {
  const channel = canaryChannels.get(branch)
  if (channel === undefined) throw new Error(`Branch ${branch} does not publish canaries`)
  return channel
}

/** Run identity stays in the prerelease, since npm does not distinguish build metadata. */
export function canaryVersion({
  version,
  build,
  channel = "next",
}: {
  readonly version: string
  readonly build: string
  readonly channel?: string
}) {
  if (!canaryChannelNames.includes(channel))
    throw new Error(`Canary channel must be one of ${canaryChannelNames.join(", ")}`)
  if (!/^[1-9]\d*\.[1-9]\d*\.g[0-9a-f]{12}$/.test(build))
    throw new Error("Canary build must be <run-id>.<attempt>.g<12-character-sha>")
  return `${version.split(/[-+]/)[0]}-${channel}.${build}`
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
        const branchIndex = process.argv.indexOf("--canary-branch")
        if (branchIndex === -1) {
          const tags = releaseTags(version)
          yield* Console.log(`tag=${tags.tag}\npromote_latest=${tags.latest}`)
          return
        }
        yield* Console.log(
          `tag=${canaryChannel(process.argv[branchIndex + 1] ?? "")}\npromote_latest=false`,
        )
      }),
    )
  } finally {
    await runtime.dispose()
  }
}
