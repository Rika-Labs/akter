import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const findRepositoryRoot = (start: string): string => {
  let current = resolve(start)

  while (!existsSync(join(current, "docs", "getting-started.md"))) {
    const parent = dirname(current)

    if (parent === current) throw new Error(`No docs/getting-started.md above ${start}`)
    current = parent
  }

  return current
}

/** The repository root, found by walking up from the working directory to `docs/getting-started.md`. */
export const repositoryRoot: string = findRepositoryRoot(process.cwd())

/** The repository's documentation directory, the single source of every published page. */
export const docsDirectory: string = join(repositoryRoot, "docs")

/** What a repository-relative path is on disk, or undefined when nothing exists there. */
export const pathKind = (repositoryPath: string): "file" | "directory" | undefined => {
  const absolute = join(repositoryRoot, repositoryPath)

  if (!existsSync(absolute)) return undefined

  return statSync(absolute).isDirectory() ? "directory" : "file"
}

/** The text of a repository-relative file. */
export const readRepositoryFile = (repositoryPath: string): string =>
  readFileSync(join(repositoryRoot, repositoryPath), "utf8")
