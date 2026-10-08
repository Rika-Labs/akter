import { Predicate, Schema } from "effect"

const Specifiers = Schema.Record(Schema.String, Schema.String)

const Exports = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
)

export const FrameworkManifest = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    private: Schema.optionalKey(Schema.Boolean),
    files: Schema.Array(Schema.String),
    dependencies: Schema.optionalKey(Specifiers),
    peerDependencies: Schema.optionalKey(Specifiers),
    bin: Schema.optionalKey(Specifiers),
    publishConfig: Schema.StructWithRest(
      Schema.Struct({ types: Schema.String, exports: Exports }),
      [Schema.Record(Schema.String, Schema.Json)],
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)

export type FrameworkManifest = typeof FrameworkManifest.Type

/** Files every framework tarball must carry besides its export targets. */
const REQUIRED_FILES = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE"]

/** Sources, tests, build caches and the spawned crash fixtures stay in the repository. */
const FORBIDDEN_FILE =
  /(^|\/)src\/|\.test\.|(^|\/)crash\/|\.tsbuildinfo$|(?<!\.d)\.ts$|(^|\/)testing\/(?:conformance(?:\/|\.)|foundation\.|cluster\.|simulate(?:-cluster)?\.)/

const resolveSpecifiers = (
  specifiers: Readonly<Record<string, string>>,
  catalog: Readonly<Record<string, string>>,
  workspaceVersions: Readonly<Record<string, string>>,
) => {
  const resolved: Record<string, string> = {}

  for (const [name, specifier] of Object.entries(specifiers)) {
    if (specifier.startsWith("workspace:")) {
      const version = workspaceVersions[name]
      if (version === undefined)
        throw new Error(`${name} is a workspace dependency this manifest may not have`)
      resolved[name] = version
      continue
    }

    const version = specifier === "catalog:" ? catalog[name] : specifier

    if (version === undefined) throw new Error(`${name} has no version in the root catalog`)
    resolved[name] = version
  }

  return resolved
}

/**
 * The manifest npm receives: `publishConfig` entries replace the workspace's
 * source-pointing `types` and `exports`, runtime dependencies stay exact, and
 * shared-library peers accept compatible releases so an application's installed
 * Effect can remain the one runtime identity. Workspace catalogs stay pinned for CI.
 * Scripts and dev dependencies are dropped because a consumer never runs them.
 */
export function publishManifest({
  manifest,
  catalog,
  workspaceVersions = {},
}: {
  manifest: FrameworkManifest
  catalog: Readonly<Record<string, string>>
  workspaceVersions?: Readonly<Record<string, string>>
}) {
  if (manifest.private === true) throw new Error("framework manifest is private")

  const { types, exports, ...publishConfig } = manifest.publishConfig

  const {
    private: _private,
    scripts: _scripts,
    devDependencies: _devDependencies,
    ...rest
  } = manifest

  return {
    ...rest,
    types,
    exports,
    dependencies: resolveSpecifiers(manifest.dependencies ?? {}, catalog, workspaceVersions),
    peerDependencies: Object.fromEntries(
      Object.entries(
        resolveSpecifiers(manifest.peerDependencies ?? {}, catalog, workspaceVersions),
      ).map(([name, version]) => [
        name,
        name === "effect" || name.startsWith("@effect/") || name === "drizzle-orm"
          ? `^${version}`
          : version,
      ]),
    ),
    publishConfig,
  }
}

/** The package a bare import specifier names: `effect/sql` names `effect`. */
const packageOf = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/")

/**
 * Bare imports in the compiled modules that name neither a builtin nor a
 * declared dependency or peer: each would fail to resolve for a consumer.
 */
export function undeclaredImports({
  sources,
  manifest,
}: {
  sources: ReadonlyArray<string>
  manifest: PackedManifest
}) {
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])

  const parser = new Bun.Transpiler({ loader: "js" })
  const specifiers = sources.flatMap((source) =>
    parser.scanImports(source.replace(/^#![^\n]*(?:\n|$)/, "")).map((entry) => entry.path),
  )

  return [
    ...new Set(
      specifiers.flatMap((specifier) => {
        if (/^(node|bun):/.test(specifier) || specifier.startsWith(".")) return []

        const name = packageOf(specifier)

        return declared.has(name) ? [] : [name]
      }),
    ),
  ].toSorted()
}

type Exports = typeof Exports.Type

export interface PackedManifest {
  readonly version: string
  readonly private?: boolean
  readonly exports: Exports
  readonly bin?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

const exportTargets = (exports: Exports) =>
  Object.values(exports).flatMap((target) =>
    Predicate.isString(target) ? [target] : Object.values(target),
  )

/** Everything wrong with a packed tarball, given its file list and manifest; empty when publishable. */
const identifier = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`

const semver = new RegExp(
  String.raw`^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)` +
    String.raw`(?:-${identifier}(?:\.${identifier})*)?` +
    String.raw`(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
)

export function tarballProblems({
  files,
  manifest,
}: {
  files: ReadonlyArray<string>
  manifest: PackedManifest
}) {
  const present = new Set(files)

  const expected = [
    ...REQUIRED_FILES,
    ...exportTargets(manifest.exports).map((target) => target.replace(/^\.\//, "")),
    ...Object.values(manifest.bin ?? {}).map((target) => target.replace(/^\.\//, "")),
  ]

  const problems = expected.flatMap((file) => (present.has(file) ? [] : [`missing ${file}`]))

  for (const file of files) if (FORBIDDEN_FILE.test(file)) problems.push(`must not publish ${file}`)

  if (manifest.private === true) problems.push("manifest is private")

  for (const [name, specifier] of Object.entries({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  }))
    if (/^(catalog|workspace):/.test(specifier))
      problems.push(`dependency ${name} is unresolved (${specifier})`)

  if (!semver.test(manifest.version))
    problems.push(`version ${manifest.version} is not a semantic version`)

  return problems
}
