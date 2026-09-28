import { parseArgs } from "node:util"
import { Effect, FileSystem, Path, Schema } from "effect"

export const templates = ["counter", "chat"] as const

export const Template = Schema.Literals(templates)

export type Template = typeof Template.Type

/** Exact versions a generated app installs; they match what `@durable-actors/core` is built against. */
export const versions = {
  "@durable-actors/core": "0.1.0-alpha.0",
  "@effect/platform-bun": "4.0.0-rc.116",
  // `@effect/platform-bun` takes this with a caret range; pinning it keeps a newer release from
  // importing `effect` modules the pinned `effect` lacks.
  "@effect/platform-node-shared": "4.0.0-rc.116",
  "@effect/sql-pg": "4.0.0-rc.116",
  "@effect/sql-pglite": "4.0.0-rc.116",
  "drizzle-orm": "1.0.0-rc.5-5935859",
  effect: "4.0.0-rc.116",
  "@types/bun": "1.4.2",
  typescript: "7.0.2",
} as const

export class UnknownTemplate extends Schema.TaggedError<UnknownTemplate>()("UnknownTemplate", {
  template: Schema.String,
}) {
  override get message() {
    return `Unknown template ${this.template}; expected one of ${templates.join(", ")}`
  }
}

export class TargetNotEmpty extends Schema.TaggedError<TargetNotEmpty>()("TargetNotEmpty", {
  directory: Schema.String,
}) {
  override get message() {
    return `${this.directory} already exists and is not empty`
  }
}

export const usage = `Usage: bun create @durable-actors [directory] [--template ${templates.join("|")}]`

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

const runtimeDependencies = [
  "@durable-actors/core",
  "@effect/platform-bun",
  "@effect/platform-node-shared",
  "@effect/sql-pg",
  "@effect/sql-pglite",
  "drizzle-orm",
  "effect",
] as const

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

export const manifest = (name: string) => ({
  name,
  private: true,
  type: "module",
  scripts: {
    start: "bun src/main.ts",
    test: "bun test",
    typecheck: "tsc -p tsconfig.json",
  },
  dependencies: Object.fromEntries(
    runtimeDependencies.map((dependency) => [dependency, versions[dependency]]),
  ),
  devDependencies: { "@types/bun": versions["@types/bun"], typescript: versions.typescript },
})

/** Package name for a target directory: its lowercased basename, with anything npm rejects replaced. */
export const packageName = (directory: string) =>
  directory
    .toLowerCase()
    .replaceAll(/[^a-z0-9._~-]+/g, "-")
    .replaceAll(/^[._-]+|-+$/g, "") || "durable-actors-app"

/**
 * Copies a template into `directory` and writes its package manifest. The
 * directory must be missing or empty; `gitignore` ships without its dot because
 * npm strips `.gitignore` from tarballs.
 */
export const scaffold = Effect.fn("scaffold")(function* (template: Template, directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const source = path.join(import.meta.dirname, "..", "templates", template)
  const target = path.resolve(directory)

  if ((yield* fs.exists(target)) && (yield* fs.readDirectory(target)).length > 0)
    return yield* TargetNotEmpty.make({ directory })

  yield* fs.makeDirectory(target, { recursive: true })
  yield* fs.copy(source, target)
  yield* fs.rename(path.join(target, "gitignore"), path.join(target, ".gitignore"))
  yield* fs.writeFileString(
    path.join(target, "package.json"),
    `${yield* encodeJson(manifest(packageName(path.basename(target))))}\n`,
  )

  return target
})
