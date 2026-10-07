import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime, Schema } from "effect"

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
        releaseVersion({ framework: framework.version, cli: cli.version })
      }),
    )
  } finally {
    await runtime.dispose()
  }
}
