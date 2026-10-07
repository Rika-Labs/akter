import { BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, ManagedRuntime } from "effect"

/** A release must carry its own changelog section rather than the notes of another version. */
export function releaseNotes({
  version,
  changelog,
}: {
  readonly version: string
  readonly changelog: string
}): string {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex(
    (line) => line === `## ${version}` || line.startsWith(`## ${version} (`),
  )
  if (start < 0) throw new Error(`No changelog section found for ${version}`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "))
  const notes = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim()
  if (notes === "") throw new Error(`Changelog section for ${version} is empty`)
  return notes
}

if (import.meta.main) {
  const runtime = ManagedRuntime.make(BunServices.layer)
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const version = process.argv[2]
        if (version === undefined)
          return yield* Effect.die(new Error("A release version is required"))
        const fs = yield* FileSystem.FileSystem
        const changelog = yield* fs.readFileString("packages/akter/CHANGELOG.md")
        yield* Console.log(releaseNotes({ version, changelog }))
      }),
    )
  } finally {
    await runtime.dispose()
  }
}
