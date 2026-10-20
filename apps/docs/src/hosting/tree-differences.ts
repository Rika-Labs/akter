import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const filesUnder = (root: string, directory = ""): ReadonlyArray<string> =>
  readdirSync(join(root, directory)).flatMap((name) => {
    const path = join(directory, name)

    return statSync(join(root, path)).isDirectory() ? filesUnder(root, path) : [path]
  })

/**
 * The files two directory trees do not share byte for byte: a file in only one tree, or in
 * both with different contents. Two builds of one commit must return nothing.
 */
export const treeDifferences = (left: string, right: string): ReadonlyArray<string> => {
  const leftFiles = new Set(filesUnder(left))
  const rightFiles = new Set(filesUnder(right))

  return [...new Set([...leftFiles, ...rightFiles])].toSorted().flatMap((path) => {
    if (!leftFiles.has(path)) return [`only in the second build: ${path}`]
    if (!rightFiles.has(path)) return [`only in the first build: ${path}`]

    return readFileSync(join(left, path)).equals(readFileSync(join(right, path)))
      ? []
      : [`differs: ${path}`]
  })
}
