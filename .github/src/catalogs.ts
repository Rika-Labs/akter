import { Effect, Schema } from "effect"

const Catalog = Schema.Record(Schema.String, Schema.mutableKey(Schema.String))

const Workspaces = Schema.StructWithRest(
  Schema.Struct({
    catalog: Schema.optionalKey(Catalog),
    catalogs: Schema.optionalKey(Schema.Record(Schema.String, Catalog)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)

export const Manifest = Schema.StructWithRest(
  Schema.Struct({ workspaces: Schema.optionalKey(Workspaces) }),
  [Schema.Record(Schema.String, Schema.Json)],
)

export type Manifest = typeof Manifest.Type

export const coupled = (name: string) =>
  /^(effect$|@effect\/|alchemy$|@alchemy.run\/|.*foldkit|typescript$|oxlint|@typescript\/native)/i.test(
    name,
  )

const ExactVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/))

function versionParts(version: string) {
  if (!Schema.is(ExactVersion)(version)) throw new Error(`Unsupported version: ${String(version)}`)

  const [base = "", prerelease] = version.split("-")
  const [major = 0, minor = 0, patch = 0] = base.split(".").map(Number)

  return { major, minor, patch, prerelease: prerelease !== undefined }
}

export function selectUpdate({
  current,
  versions,
}: {
  current: string
  versions: readonly string[]
}) {
  const base = versionParts(current)

  if (base.prerelease)
    return { version: current, blocked: "prerelease requires compatibility proof" }
  let selected = current
  let highest = base

  for (const candidate of versions) {
    if (!Schema.is(ExactVersion)(candidate)) continue
    const parsed = versionParts(candidate)

    if (parsed.prerelease || parsed.major !== base.major) continue

    if (
      parsed.minor > highest.minor ||
      (parsed.minor === highest.minor && parsed.patch > highest.patch)
    ) {
      selected = candidate
      highest = parsed
    }
  }

  return { version: selected }
}

export const updateCatalogs = Effect.fn("updateCatalogs")(function* (
  manifest: Manifest,
  registry: (name: string) => Effect.Effect<readonly string[], Schema.SchemaError>,
) {
  const next = structuredClone(manifest)
  const report: { name: string; from: string; to: string; blocked?: string }[] = []
  const catalogs = Object.values(next.workspaces?.catalogs ?? {})

  if (next.workspaces?.catalog !== undefined) catalogs.unshift(next.workspaces.catalog)

  for (const catalog of catalogs)
    for (const [name, current] of Object.entries(catalog)) {
      const versions = yield* registry(name)
      const selected = selectUpdate({ current, versions })

      const blocked =
        selected.blocked ??
        (coupled(name) && selected.version !== current
          ? "coupled cohort requires compatibility proof"
          : undefined)

      report.push({ name, from: current, to: selected.version, blocked })

      if (blocked === undefined) catalog[name] = selected.version
    }

  return { manifest: next, report }
})
