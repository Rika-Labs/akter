const OWNED_ROOTS = new Set(["apps", "packages", "tooling", "infra"])

/** Directory names that say nothing about what a folder owns. */
export const FORBIDDEN_SEGMENTS = new Set([
  "core",
  "shared",
  "common",
  "utils",
  "helpers",
  "lib",
  "misc",
  "domain",
  "types",
  "internal",
])

const SOURCE_FILE = /\.[cm]?[jt]sx?$/

/**
 * Path segments from the first governed root (apps, packages, tooling,
 * infra), or null outside them.
 */
export function repoSegments(filename: string): ReadonlyArray<string> | null {
  const segments = filename.replaceAll("\\", "/").split("/").filter(Boolean)
  const anchor = segments.findIndex((segment) => OWNED_ROOTS.has(segment))

  if (anchor === -1) return null

  return segments.slice(anchor)
}

/** Like `repoSegments`, but null unless the path is a source file below a root. */
export function repoSourceSegments(filename: string): ReadonlyArray<string> | null {
  const segments = repoSegments(filename)

  if (segments === null || segments.length < 2) return null
  const leaf = segments[segments.length - 1]

  if (leaf === undefined || !SOURCE_FILE.test(leaf)) return null

  return segments
}
