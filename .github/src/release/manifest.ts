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
const FORBIDDEN_FILE = /(^|\/)src\/|\.test\.|(^|\/)crash\/|\.tsbuildinfo$|(?<!\.d)\.ts$/

const resolveSpecifiers = (
  specifiers: Readonly<Record<string, string>>,
  catalog: Readonly<Record<string, string>>,
  workspace: Readonly<Record<string, string>> = {},
) => {
  const resolved: Record<string, string> = {}

  for (const [name, specifier] of Object.entries(specifiers)) {
    if (specifier.startsWith("workspace:")) {
      const version = workspace[name]

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

const TemplateSpecifier = Schema.String.check(
  Schema.isPattern(/^(catalog:|workspace:\*)$/, {
    message: "a template names catalog: or workspace:*, never a copied version",
  }),
)

/** The scaffold's manifest source: its fields, with each dependency named by `catalog:` or `workspace:*`. */
export const TemplateManifest = Schema.StructWithRest(
  Schema.Struct({
    dependencies: Schema.Record(Schema.String, TemplateSpecifier),
    devDependencies: Schema.Record(Schema.String, TemplateSpecifier),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)

export type TemplateManifest = typeof TemplateManifest.Type

/**
 * The manifest a scaffolded app receives, pinned to exactly what the
 * workspace builds and releases with: `catalog:` takes the root catalog's
 * version, or the root dev dependency's for tools such as `@types/bun` that the
 * catalog does not list, and `workspace:*` takes the framework's own version.
 * Throws when the app would miss a framework peer dependency, which a package
 * manager would otherwise resolve to whatever is newest.
 */
export function pinTemplateManifest({
  template,
  catalog,
  rootDevDependencies,
  framework,
}: {
  template: TemplateManifest
  catalog: Readonly<Record<string, string>>
  rootDevDependencies: Readonly<Record<string, string>>
  framework: FrameworkManifest
}) {
  const pins = { ...rootDevDependencies, ...catalog }
  const workspace = { [framework.name]: framework.version }

  const missing = Object.keys(framework.peerDependencies ?? {}).filter(
    (name) => !(name in template.dependencies),
  )

  if (missing.length > 0)
    throw new Error(`the template does not install framework peers: ${missing.join(", ")}`)

  return {
    ...template,
    dependencies: resolveSpecifiers(template.dependencies, pins, workspace),
    devDependencies: resolveSpecifiers(template.devDependencies, pins, workspace),
  }
}

/**
 * The manifest npm receives: `publishConfig` entries replace the workspace's
 * source-pointing `types` and `exports`, `catalog:` versions become exact, and
 * scripts and dev dependencies are dropped because a consumer never runs them.
 */
export function publishManifest({
  manifest,
  catalog,
}: {
  manifest: FrameworkManifest
  catalog: Readonly<Record<string, string>>
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
    dependencies: resolveSpecifiers(manifest.dependencies ?? {}, catalog),
    peerDependencies: resolveSpecifiers(manifest.peerDependencies ?? {}, catalog),
    publishConfig,
  }
}

/** The package a bare import specifier names: `effect/unstable/sql` names `effect`. */
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

  const specifiers = sources.flatMap((source) =>
    [...source.matchAll(/(?:from|import)\s*\(?\s*(["'])([^"'./][^"']*)\1/g)].flatMap((match) =>
      match[2] === undefined ? [] : [match[2]],
    ),
  )

  return [
    ...new Set(
      specifiers.flatMap((specifier) => {
        if (/^(node|bun):/.test(specifier)) return []

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
