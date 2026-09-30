import { parseArgs } from "node:util"
import { Effect, FileSystem, Path, Schema } from "effect"

/** Names of the templates `bun create @durable-actors` can scaffold. */
export const templates = ["counter", "chat"] as const

/** A template name. */
export const Template = Schema.Literals(templates)

/** A template name. */
export type Template = typeof Template.Type

/** The requested template is not one of `templates`. */
export class UnknownTemplate extends Schema.TaggedError<UnknownTemplate>()("UnknownTemplate", {
  template: Schema.String,
}) {
  override get message() {
    return `Unknown template ${this.template}; expected one of ${templates.join(", ")}`
  }
}

/** The target directory exists and already has files; nothing is written. */
export class TargetNotEmpty extends Schema.TaggedError<TargetNotEmpty>()("TargetNotEmpty", {
  directory: Schema.String,
}) {
  override get message() {
    return `${this.directory} already exists and is not empty`
  }
}

/** Command-line usage text. */
export const usage = `Usage: bun create @durable-actors [directory] [--template ${templates.join("|")}]`

/** The command line could not be parsed; the message includes `usage`. */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  reason: Schema.String,
}) {
  override get message() {
    return `${this.reason}\n${usage}`
  }
}

/** Reads `[directory] [--template name] [--help]`, rejecting unknown options and extra arguments. */
export const parseArguments = Effect.fn("parseArguments")(function* (args: ReadonlyArray<string>) {
  const { values, positionals } = yield* Effect.try({
    try: () =>
      parseArgs({
        args: [...args],
        options: { template: { type: "string" }, help: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
      }),
    catch: (cause) =>
      UsageError.make({ reason: cause instanceof Error ? cause.message : String(cause) }),
  })

  if (positionals.length > 1)
    return yield* UsageError.make({ reason: `Unexpected argument ${positionals[1]}` })

  if (values.help === true) return { help: true } as const

  const requested = values.template ?? "counter"

  const template = yield* Schema.decodeUnknownEffect(Template)(requested).pipe(
    Effect.mapError(() => UnknownTemplate.make({ template: requested })),
  )

  return { help: false, template, directory: positionals[0] ?? "durable-actors-app" } as const
})

const PinnedManifest = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      dependencies: Schema.Record(Schema.String, Schema.String),
      devDependencies: Schema.Record(Schema.String, Schema.String),
    }),
    [Schema.Record(Schema.String, Schema.Json)],
  ),
)

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

/** Package name for a target directory: its lowercased basename, with anything npm rejects replaced. */
export const packageName = (directory: string) =>
  directory
    .toLowerCase()
    .replaceAll(/[^a-z0-9._~-]+/g, "-")
    .replaceAll(/^[._-]+|-+$/g, "") || "durable-actors-app"

/**
 * Copies the shared base and then the template's own files into `directory`,
 * and writes its package manifest from the pinned `dist/manifest.json` the
 * package build produced. The directory must be missing or empty; `gitignore`
 * ships without its dot because npm strips `.gitignore` from tarballs.
 */
export const scaffold = Effect.fn("scaffold")(function* (template: Template, directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.join(import.meta.dirname, "..")
  const target = path.resolve(directory)

  const manifest = yield* Schema.decodeEffect(PinnedManifest)(
    yield* fs.readFileString(path.join(packageRoot, "dist", "manifest.json")),
  )

  if ((yield* fs.exists(target)) && (yield* fs.readDirectory(target)).length > 0)
    return yield* TargetNotEmpty.make({ directory })

  yield* fs.makeDirectory(target, { recursive: true })
  yield* fs.copy(path.join(packageRoot, "templates", "base"), target)
  yield* fs.copy(path.join(packageRoot, "templates", template), target)
  yield* fs.rename(path.join(target, "gitignore"), path.join(target, ".gitignore"))
  yield* fs.writeFileString(
    path.join(target, "package.json"),
    `${yield* encodeJson({ name: packageName(path.basename(target)), ...manifest })}\n`,
  )

  return target
})
