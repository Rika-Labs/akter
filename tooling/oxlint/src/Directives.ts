import { BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, ManagedRuntime, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { parseSync } from "oxc-parser"

interface Source {
  readonly file: string
  readonly text: string
}

export function violations(source: Source) {
  const parsed = parseSync(source.file, source.text)

  if (parsed.errors.length !== 0)
    throw new Error(`Cannot check lint directives in invalid source: ${source.file}`)

  return parsed.comments.flatMap((comment) => {
    if (!/^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?=\s|$)/.test(comment.value)) return []

    const line = source.text.slice(0, comment.start).split("\n").length

    return [`${source.file}:${line}: Lint disable directives are banned; fix the code instead.`]
  })
}

export const check = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const command = ChildProcess.make("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ])

  const handle = yield* spawner.spawn(command)
  const output = yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString)

  if ((yield* handle.exitCode) !== 0)
    return yield* Effect.die(new Error("Cannot enumerate repository source files with Git"))

  const files = output.split("\0")
  const findings: string[] = []

  for (const file of new Set(files)) {
    if (!/\.[cm]?[jt]sx?$/.test(file) || !(yield* fs.exists(file))) continue
    const text = yield* fs.readFileString(file)
    findings.push(...violations({ file, text }))
  }

  for (const finding of findings) yield* Console.error(finding)

  if (findings.length !== 0) return yield* DirectiveError.make({ count: findings.length })

  yield* Console.log("No lint disable directives found.")
})

class DirectiveError extends Schema.TaggedError<DirectiveError>()("DirectiveError", {
  count: Schema.Int,
}) {}

if (import.meta.main) {
  const runtime = ManagedRuntime.make(BunServices.layer)
  await runtime.runPromise(check.pipe(Effect.scoped)).finally(() => runtime.dispose())
}
